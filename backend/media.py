"""
media.py

"Pause", "resume", "next song", "what's playing?", "turn it up": controls
whatever is playing on this PC — YouTube in Brave/Chrome/Edge, Spotify, etc.

Uses Windows' own media sessions (the same ones behind the volume flyout's
play/pause buttons), so "pause" really pauses and never accidentally starts
something. If those aren't available it falls back to pressing the keyboard's
media keys. Nothing here leaves the laptop.

In the app, Windows' media API runs in a separate little process
(media_helper.py): alongside the speech engines' native code it can crash the
process it's in (reproduced). Use run() and sessions(), which go through the
helper; control() is the logic itself (used by the helper, and by tests).
"""

import asyncio
import ctypes
import json
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Awaitable, Callable, Optional

from youtube import spoken_title

COMMANDS = {"play", "pause", "toggle", "next", "previous", "status", "volume_up", "volume_down", "mute"}

# Windows virtual-key codes for the media keys.
VK = {
    "toggle": 0xB3,  # VK_MEDIA_PLAY_PAUSE
    "next": 0xB0,
    "previous": 0xB1,
    "mute": 0xAD,
    "volume_down": 0xAE,
    "volume_up": 0xAF,
}
VOLUME_STEPS = 5  # each press is 2%, so 10% per request

# GlobalSystemMediaTransportControlsSessionPlaybackStatus
PLAYING, PAUSED = 4, 5

KNOWN_APPS = {"brave": "Brave", "chrome": "Chrome", "msedge": "Edge", "firefox": "Firefox", "spotify": "Spotify", "vlc": "VLC"}


def _press_key(vk: int, times: int = 1) -> None:
    KEYEVENTF_KEYUP = 0x2
    for _ in range(times):
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
        ctypes.windll.user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


async def _windows_manager():
    """Windows' media session manager, or None if unavailable."""
    if sys.platform != "win32":
        return None
    try:
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Manager
    except ImportError:
        return None
    try:
        return await Manager.request_async()
    except Exception:
        return None


# Swappable in tests.
press_key: Callable[[int, int], None] = _press_key
get_manager: Callable[[], Awaitable[object]] = _windows_manager

# Talk to Windows' media sessions through the helper process (see the top).
ISOLATE = sys.platform == "win32"
HELPER_TIMEOUT_S = 5.0


class _Helper:
    """The media_helper.py process: started on first use, restarted if it dies."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lines: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        self._next_id = 0

    def _ensure(self) -> subprocess.Popen:
        if self._proc is None or self._proc.poll() is not None:
            self._lines = queue.Queue()
            self._proc = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name("media_helper.py"))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8", bufsize=1, cwd=str(Path(__file__).parent),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            lines, out = self._lines, self._proc.stdout
            threading.Thread(target=lambda: [lines.put(line) for line in out], daemon=True).start()
        return self._proc

    def request(self, msg: dict) -> dict:
        with self._lock:
            for attempt in range(2):  # a dead helper gets one restart
                proc = self._ensure()
                self._next_id += 1
                try:
                    proc.stdin.write(json.dumps({"id": self._next_id, **msg}) + "\n")
                    proc.stdin.flush()
                    while True:
                        reply = json.loads(self._lines.get(timeout=HELPER_TIMEOUT_S))
                        if reply.get("id") == self._next_id:
                            return reply
                except (OSError, ValueError, queue.Empty):
                    self.stop()
            return {"error": "media helper unavailable"}

    def stop(self) -> None:
        if self._proc is not None:
            try:
                self._proc.kill()
            except OSError:
                pass
            self._proc = None


helper = _Helper()


async def run(command: object) -> tuple[bool, str]:
    """control(), safely (through the helper process in the app)."""
    if not ISOLATE:
        return await control(command)
    reply = await asyncio.to_thread(helper.request, {"cmd": "control", "command": command})
    if "error" in reply:
        return False, "I can't reach the media controls right now."
    return bool(reply.get("ok")), str(reply.get("text") or "")


async def sessions() -> list[dict]:
    """What's in Windows' media sessions: [{app, playing, title, artist}] (safely, like run())."""
    if ISOLATE:
        reply = await asyncio.to_thread(helper.request, {"cmd": "sessions"})
        return list(reply.get("sessions") or [])
    manager = await get_manager()
    if manager is None:
        return []
    out = []
    for s in list(manager.get_sessions()):
        try:
            props = await s.try_get_media_properties_async()
            title, artist = props.title or "", props.artist or ""
        except Exception:
            title, artist = "", ""
        out.append({"app": s.source_app_user_model_id or "", "playing": _status(s) == PLAYING, "title": title, "artist": artist})
    return out


def app_name(source_id: str) -> str:
    s = (source_id or "").lower()
    for key, name in KNOWN_APPS.items():
        if key in s:
            return name
    tail = (source_id or "").split("!")[-1].removesuffix(".exe")
    return tail or "an app"


def _status(session) -> int:
    try:
        return int(session.get_playback_info().playback_status)
    except Exception:
        return -1


async def _describe(session) -> str:
    where = app_name(session.source_app_user_model_id)
    try:
        props = await session.try_get_media_properties_async()
        title, artist = (props.title or "").strip(), (props.artist or "").strip()
    except Exception:
        title, artist = "", ""
    state = "playing" if _status(session) == PLAYING else "paused"
    if not title:
        return f"Something is {state} in {where}."
    by = f" by {artist}" if artist and len(artist) <= 40 else ""
    return f"That's \"{spoken_title(title)}\"{by} in {where}, {state}."


async def control(command: object) -> tuple[bool, str]:
    """Returns (ok, message to say)."""
    cmd = str(command or "").strip().lower().replace("-", "_").replace(" ", "_")
    cmd = {"resume": "play", "unpause": "play", "stop": "pause", "skip": "next", "prev": "previous", "back": "previous", "louder": "volume_up", "quieter": "volume_down"}.get(cmd, cmd)
    if cmd not in COMMANDS:
        return False, "I can play, pause, skip, go back, change the volume, or tell you what's playing."

    # Volume has no media-session API; the keys change the system volume.
    if cmd in ("volume_up", "volume_down", "mute"):
        press_key(VK[cmd], VOLUME_STEPS if cmd != "mute" else 1)
        return True, {"volume_up": "Turned it up.", "volume_down": "Turned it down.", "mute": "Toggled mute."}[cmd]

    manager = await get_manager()
    if manager is None:
        if cmd == "status":
            return False, "I can't see what's playing on this PC."
        press_key(VK["toggle" if cmd in ("play", "pause") else cmd], 1)
        return True, {"play": "Pressed play.", "pause": "Pressed pause.", "toggle": "Done.", "next": "Skipped.", "previous": "Going back."}[cmd]

    sessions = list(manager.get_sessions())
    current = manager.get_current_session()
    playing = [s for s in sessions if _status(s) == PLAYING]
    paused = [s for s in sessions if _status(s) == PAUSED]

    if cmd == "status":
        target = playing[0] if playing else current
        return (True, await _describe(target)) if target else (True, "Nothing's playing right now.")

    if cmd == "toggle":
        cmd = "pause" if playing else "play"

    if cmd == "pause":
        if not playing:
            return True, "Nothing's playing right now."
        for s in playing:  # "pause" means quiet: pause everything that's playing
            await s.try_pause_async()
        return True, "Paused."

    if cmd == "play":
        if playing:
            return True, "It's already playing."
        target = current if current is not None and _status(current) == PAUSED else (paused[0] if paused else None)
        if target is None:
            return True, "There's nothing paused to resume — ask me to play something."
        await target.try_play_async()
        return True, "Playing again."

    # next / previous: whatever is playing, else whatever Windows considers current.
    target = playing[0] if playing else current
    if target is None:
        return True, "Nothing's playing right now."
    where = app_name(target.source_app_user_model_id)
    if not _button_enabled(target, cmd):
        # A single YouTube video in a browser has no "next" button: Windows
        # accepts the skip and the browser silently drops it. Seek instead:
        # to the end (YouTube's autoplay starts "Up next"), or to the start.
        if await _seek(target, to_end=cmd == "next"):
            return True, "Skipped to the end. Autoplay will start the next one." if cmd == "next" else "Back to the start."
        return True, f"{where} won't let me skip that one."
    ok = await (target.try_skip_next_async() if cmd == "next" else target.try_skip_previous_async())
    if not ok:
        return True, f"{where} won't let me skip that one."
    return True, "Skipped." if cmd == "next" else "Going back."


def _button_enabled(session, cmd: str) -> bool:
    """Is the app's own next/previous button on? (True if Windows won't say.)"""
    try:
        controls = session.get_playback_info().controls
        return bool(controls.is_next_enabled if cmd == "next" else controls.is_previous_enabled)
    except Exception:
        return True


async def _seek(session, to_end: bool) -> bool:
    """Jump to the end (minus a moment, so the player sees it finish) or the start."""
    try:
        if not session.get_playback_info().controls.is_playback_position_enabled:
            return False
        timeline = session.get_timeline_properties()
        end = timeline.max_seek_time or timeline.end_time
        if to_end and end.total_seconds() < 2:
            return False  # length unknown (e.g. a live stream)
        at = (end.total_seconds() - 0.5) if to_end else timeline.min_seek_time.total_seconds()
        return bool(await session.try_change_playback_position_async(int(at * 10_000_000)))  # 100 ns ticks
    except Exception:
        return False
