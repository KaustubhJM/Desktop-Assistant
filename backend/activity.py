"""
activity.py

What you're up to, so the robot can match it: focused while you code, happy
while you watch YouTube, dancing when a song plays.

It never looks at your screen. Every couple of seconds it asks Windows two
things:
  - which app is in front, and that window's title ("… - YouTube - Brave")
  - what's playing in Windows' media sessions (the same info as the volume
    flyout: app, title, artist/channel, playing or paused)
and boils them down to one word: coding, watching, music or none. Only that
word leaves this module (to the robot window). Titles are never stored,
logged or sent anywhere. Off when you switch it off in Settings.

Changes must hold for a few seconds before the robot reacts, so alt-tabbing
doesn't make it flicker between moods.
"""

import asyncio
import ctypes
import re
import sys
import threading
import time
from ctypes import wintypes
from typing import Awaitable, Callable, Optional

import media

POLL_S = 2.0
STABLE_S = 4.0

CODING_APPS = {
    "code.exe", "code - insiders.exe", "cursor.exe", "windsurf.exe", "zed.exe", "devenv.exe", "idea64.exe",
    "pycharm64.exe", "webstorm64.exe", "clion64.exe", "goland64.exe", "rider64.exe", "phpstorm64.exe",
    "studio64.exe", "sublime_text.exe", "notepad++.exe", "eclipse.exe", "neovide.exe", "nvim-qt.exe",
    "windowsterminal.exe", "wt.exe", "powershell.exe", "pwsh.exe", "cmd.exe", "mintty.exe", "alacritty.exe",
    "wezterm-gui.exe", "arduino ide.exe", "spyder.exe", "rstudio.exe", "matlab.exe",
}
BROWSERS = {"brave.exe", "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "opera_gx.exe", "vivaldi.exe", "arc.exe"}
CODING_SITES = re.compile(
    r"github|gitlab|stack ?overflow|leetcode|codeforces|codechef|geeksforgeeks|hackerrank|hackerearth|replit|"
    r"codepen|codesandbox|localhost|127\.0\.0\.1|colab|jupyter|kaggle|mdn web docs|w3schools|docs\.python",
    re.I,
)
VIDEO_SITES = re.compile(r"youtube|netflix|prime video|hotstar|jiocinema|twitch|vimeo|crunchyroll|zee5|sonyliv", re.I)
MUSIC_APPS = re.compile(r"spotify|applemusic|apple music|zunemusic|music\.ui|aimp|foobar|musicbee|winamp|itunes|amazon ?music|tidal|deezer|jiosaavn|gaana|wynk", re.I)
VIDEO_APPS = {"vlc.exe", "potplayermini64.exe", "potplayer.exe", "mpc-hc64.exe", "mpc-be64.exe", "mpv.exe", "netflix.exe", "video.ui.exe", "wmplayer.exe"}
# A YouTube video that's really a song: the title or channel usually says so.
SONG_TITLE = re.compile(
    r"official (music )?(video|audio)|music video|\(not a mv\)|\bmv\b|lyric|\baudio\b|\bsongs?\b|lo-?fi|remix|"
    r"\bft\.|\bfeat\.?\b|jukebox|full video|\bbeats\b|playlist|\bmix\b|\bhits\b|slowed|reverb|\bcover\b|acoustic|"
    r"unplugged|karaoke|\bdj\b|bhajan|qawwali|ghazal|nonstop|mashup",
    re.I,
)
SONG_CHANNEL = re.compile(
    r"- topic$|vevo|\bmusic\b|records|t-series|saregama|sony|zee music|tips|speed records|yrf|desi melodies|"
    r"white hill|lofi|geet mp3|eros now|venus|times music|bollywood|punjabi|beats",
    re.I,
)


# ------------------------------------------------------------ what's in front

def foreground() -> tuple[str, str]:
    """(exe name, window title) of the app in front. ("", "") if unknown."""
    if sys.platform != "win32":
        return "", ""
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return "", ""
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    exe = ""
    handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if handle:
        try:
            size = wintypes.DWORD(1024)
            path = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                exe = path.value.rsplit("\\", 1)[-1].lower()
        finally:
            kernel32.CloseHandle(handle)
    return exe, buf.value


def foreground_rect() -> Optional[dict]:
    """
    Where the window in front is (physical pixels), for the robot to perch on
    its title bar. No title, just geometry: visible frame (without the
    invisible resize borders), maximised / full screen, and whether it's ours.
    """
    if sys.platform != "win32":
        return None
    user32, dwm = ctypes.windll.user32, ctypes.windll.dwmapi
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    r = RECT()
    if dwm.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) != 0:  # DWMWA_EXTENDED_FRAME_BOUNDS
        user32.GetWindowRect(hwnd, ctypes.byref(r))

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", RECT), ("rcWork", RECT), ("dwFlags", ctypes.c_ulong)]

    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(mi))
    m = mi.rcMonitor
    exe, _ = foreground()
    return {
        "x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top,
        "maximized": bool(user32.IsZoomed(hwnd)),
        "fullscreen": (r.left, r.top, r.right, r.bottom) == (m.left, m.top, m.right, m.bottom),
        "ours": exe in ("electron.exe", "bit.exe"),
    }


async def playing_now() -> list[dict]:
    """Windows media sessions: [{app, playing, title, artist}] (via media.py's helper process)."""
    return await media.sessions()


# ------------------------------------------------------------ deciding

def is_song(session: dict) -> bool:
    if MUSIC_APPS.search(session["app"]):
        return True
    return bool(SONG_TITLE.search(session["title"]) or SONG_CHANNEL.search(session["artist"]))


def classify(exe: str, title: str, sessions: list[dict]) -> dict:
    """-> {"activity": coding|music|watching|none, "music": bool (a song is playing)}"""
    playing = [s for s in sessions if s["playing"]]
    song = any(is_song(s) for s in playing) or (exe in BROWSERS and "youtube music" in title.lower() and bool(playing))
    video = any(not is_song(s) for s in playing)
    coding = exe in CODING_APPS or (exe in BROWSERS and bool(CODING_SITES.search(title)))
    if coding:
        return {"activity": "coding", "music": song}
    if song:
        return {"activity": "music", "music": True}
    if video or exe in VIDEO_APPS or (exe in BROWSERS and VIDEO_SITES.search(title)) or MUSIC_APPS.search(exe):
        return {"activity": "watching", "music": False}
    return {"activity": "none", "music": False}


class ActivityWatcher:
    def __init__(
        self,
        on_change: Callable[[dict], None],
        read_foreground: Callable[[], tuple[str, str]] = foreground,
        read_media: Callable[[], Awaitable[list[dict]]] = playing_now,
        ignore_exes: tuple[str, ...] = ("electron.exe", "bit.exe"),  # the robot itself
        clock: Callable[[], float] = time.monotonic,
    ):
        self.on_change = on_change
        self.read_foreground = read_foreground
        self.read_media = read_media
        self.ignore_exes = ignore_exes
        self.clock = clock
        self.enabled = False
        self.current: dict = {"activity": "none", "music": False}
        self._pending: Optional[dict] = None
        self._pending_since = 0.0
        self._last_front = ("", "")
        self._first = True
        self._thread: Optional[threading.Thread] = None

    def start(self) -> dict:
        self.enabled = True
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, daemon=True, name="activity")
            self._thread.start()
        return self.status()

    def stop(self) -> dict:
        self.enabled = False
        self._first = True
        if self.current["activity"] != "none" or self.current["music"]:
            self.current = {"activity": "none", "music": False}
            self._emit()
        return self.status()

    def status(self) -> dict:
        return {"enabled": self.enabled, **self.current}

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        while True:
            if self.enabled:
                try:
                    self.poll(loop.run_until_complete(self.read_media()))
                except Exception as err:
                    print(f"[activity] {type(err).__name__}")  # never the titles
            time.sleep(POLL_S)

    def poll(self, sessions: list[dict]) -> None:
        exe, title = self.read_foreground()
        if exe in self.ignore_exes or not exe:
            exe, title = self._last_front  # clicking the robot isn't "doing something else"
        else:
            self._last_front = (exe, title)
        seen = classify(exe, title, sessions)
        now = self.clock()
        if seen == self.current:
            self._pending = None
        elif self._first:
            self.current = seen  # first look: no need to wait
            self._emit()
        elif seen != self._pending:
            self._pending, self._pending_since = seen, now
        elif now - self._pending_since >= STABLE_S:
            self.current, self._pending = seen, None
            self._emit()
        self._first = False

    def _emit(self) -> None:
        try:
            self.on_change({"type": "activity", "text": "", **self.current})
        except Exception as err:
            print(f"[activity] couldn't deliver: {err}")
