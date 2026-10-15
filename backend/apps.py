"""
apps.py

Opening apps on this laptop: "open VS Code", "launch WhatsApp", "start Steam".

Only apps from your Start menu can be opened: the same list Windows shows
there (desktop programs, Store apps and games), read with PowerShell's
Get-StartApps. The model only names the app it heard; this module picks the
closest Start menu entry and asks Windows to start it the way the Start menu
does (explorer.exe shell:AppsFolder\\<AppID>). Nothing the model writes is
ever run as a command, no file paths or arguments are passed, and entries
that aren't apps are left out: uninstallers and "reset"/"delete" tools,
scripts (.bat, .ps1...), read-me files and web links.

The list of your apps stays on the laptop: it's never put in a prompt. Only
your own words go to the AI, as with any message.
"""

import asyncio
import difflib
import json
import os
import re
import subprocess
import threading
import time
from typing import Callable, Optional

CACHE_S = 600  # the Start menu is read again after this long...
RESCAN_AFTER_S = 30  # ...or sooner when an app isn't found (just installed?)
SCAN_TIMEOUT_S = 15
MIN_SCORE = 60  # anything weaker is "I couldn't find it", not a guess
STRONG_SCORE = 75  # "open X" answered without the model needs a clear match
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Start menu entries that undo or break things: never started by voice.
RISKY_NAME = re.compile(r"\b(?:uninstall\w*|remove|delete|reset|repair)\b", re.I)
# Not apps: scripts, documents and web pages that Start menu folders also hold.
NOT_AN_APP = re.compile(r"\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|reg|msi|txt|md|html?|chm|pdf|rtf|url|ini|log)$", re.I)
WEB_LINK = re.compile(r"^[a-z][a-z0-9+.-]*://", re.I)
STEAM_GAME = re.compile(r"steam://rungameid/\d+")  # games Steam adds to the Start menu

# Words that don't help tell apps apart ("open the Microsoft Word app" -> "word").
FILLER = {"the", "my", "app", "application", "program", "microsoft", "windows"}
# What people call some apps.
ALIASES = {
    "vs code": "visual studio code", "vscode": "visual studio code", "code": "visual studio code",
    "cmd": "command prompt", "calc": "calculator", "files": "file explorer", "file manager": "file explorer",
    "this pc": "file explorer", "my computer": "file explorer",
}
# Websites, not apps: "open YouTube" is the model's call (youtube / search), not Chrome's.
WEBSITES = {"google", "youtube", "gmail", "facebook", "instagram", "twitter", "x", "reddit", "chatgpt", "netflix", "amazon"}


def _scan() -> list[dict]:
    """Your Start menu's apps as [{name, id}], from Windows (about a second)."""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
        capture_output=True, timeout=SCAN_TIMEOUT_S, creationflags=NO_WINDOW,
    )
    data = json.loads(out.stdout.decode("utf-8", "replace").strip() or "[]")
    if isinstance(data, dict):  # PowerShell sends a lone app as an object, not a list
        data = [data]
    return [{"name": str(d.get("Name") or "").strip(), "id": str(d.get("AppID") or "").strip()} for d in data if isinstance(d, dict)]


def _launch(app: dict) -> None:
    """Start it like the Start menu does. Returns at once (explorer hands it over)."""
    if os.getenv("REMINDER_APPS_DRY_RUN") == "1":  # the app's self-test: nothing really opens
        print(f"[apps] (dry run) would open {app['name']}")
        return
    target = app["id"] if STEAM_GAME.fullmatch(app["id"]) else f"shell:AppsFolder\\{app['id']}"
    subprocess.Popen(["explorer.exe", target], creationflags=NO_WINDOW, close_fds=True)


# Swappable: the tests use a fake Start menu and record what would open.
SOURCE: Callable[[], list[dict]] = _scan
LAUNCH: Callable[[dict], None] = _launch

_cache: dict = {"at": 0.0, "apps": []}
_lock = threading.Lock()


def _launchable(app: dict) -> bool:
    name, app_id = app.get("name") or "", app.get("id") or ""
    if not name or not app_id or RISKY_NAME.search(name) or NOT_AN_APP.search(app_id):
        return False
    return not WEB_LINK.match(app_id) or bool(STEAM_GAME.fullmatch(app_id))


def installed(max_age: float = CACHE_S) -> list[dict]:
    """The apps that can be opened (cached; blocks for a scan, so call it from a thread)."""
    with _lock:
        if _cache["at"] and time.time() - _cache["at"] < max_age:
            return _cache["apps"]
        try:
            apps = [a for a in SOURCE() if _launchable(a)]
        except Exception as err:  # no PowerShell, timeout, odd output
            print(f"[apps] couldn't read the Start menu ({type(err).__name__})")
            return _cache["apps"]
        _cache.update(at=time.time(), apps=apps)
        return apps


def reset() -> None:
    """Forget the cached list (tests, after swapping SOURCE)."""
    with _lock:
        _cache.update(at=0.0, apps=[])


def _words(text: str) -> list[str]:
    text = text.lower().replace("&", " and ").replace("’", "").replace("'", "")
    return re.findall(r"[a-z0-9]+", text)


def _queries(name: str) -> list[list[str]]:
    """Ways to read what was asked: without filler words first, then as said ("whats app" keeps its "app")."""
    said = _words(name)
    out = []
    for words in ([w for w in said if w not in FILLER], said):
        joined = " ".join(words)
        words = ALIASES[joined].split() if joined in ALIASES else words
        if words and words not in out:
            out.append(words)
    return out


def score(query: list[str], name: str) -> float:
    """How well an app's name fits what was asked (0 = not at all, 100 = exactly)."""
    words = _words(name)
    if not query or not words:
        return 0
    extra = len(words) - len(query)
    if words == query:
        return 100
    squashed_q, squashed_n = "".join(query), "".join(words)
    if squashed_q == squashed_n:
        return 95  # "whats app" -> WhatsApp
    if words[: len(query)] == query:
        return 90 - extra  # "pycharm" -> PyCharm 2025.2.4
    if set(query) <= set(words):
        return 80 - extra  # "chrome" -> Google Chrome; fewer extra words wins
    if len(squashed_q) >= 5:
        if squashed_q in squashed_n:
            return 70 - (len(squashed_n) - len(squashed_q)) / 4  # "photo" -> Photos
        ratio = difflib.SequenceMatcher(None, squashed_q, squashed_n).ratio()
        if ratio >= 0.85:
            return 60 + (ratio - 0.85) * 60  # misheard: "visual studio cold"
    return 0


def find(name: object, min_score: float = MIN_SCORE) -> Optional[dict]:
    """The installed app that best fits the name, or None. Ties go to the shorter name."""
    queries = _queries(" ".join(str(name or "").split())[:80])
    best, best_score = None, 0.0
    for app in installed():
        s = max((score(q, app["name"]) for q in queries), default=0)
        if s > best_score or (s == best_score and best is not None and len(app["name"]) < len(best["name"])):
            best, best_score = app, s
    return best if best_score >= min_score else None


def strong_match(name: str) -> Optional[dict]:
    """For "open X" without asking the model: only a clear match, and never for a website."""
    if any(" ".join(q) in WEBSITES for q in _queries(name)):
        return None
    return find(name, STRONG_SCORE)


async def open_app(name: object) -> tuple[bool, str]:
    """Returns (opened, what to say)."""
    asked = " ".join(str(name or "").split())[:80]
    if not asked:
        return False, "Which app should I open?"
    app = await asyncio.to_thread(find, asked)
    if app is None and time.time() - _cache["at"] > RESCAN_AFTER_S:
        reset_at = _cache["at"]
        with _lock:
            if _cache["at"] == reset_at:
                _cache["at"] = 0.0  # look at the Start menu again: maybe it was just installed
        app = await asyncio.to_thread(find, asked)
    if app is None:
        return False, f"I couldn't find an app called \"{asked}\" on your laptop."
    try:
        await asyncio.to_thread(LAUNCH, app)
    except Exception as err:
        print(f"[apps] couldn't open {app['name']} ({type(err).__name__})")
        return False, f"I couldn't open {app['name']}, sorry."
    return True, f"Opening {app['name']}."
