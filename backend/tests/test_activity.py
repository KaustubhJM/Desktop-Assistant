"""
Tests for activity.py (what you're doing -> the robot's mood), with fake
foreground windows and media sessions. Nothing real is read.

Run:  venv\\Scripts\\python tests\\test_activity.py
"""

import sys
import traceback
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import activity  # noqa: E402
from activity import classify  # noqa: E402


def song(title, artist="", app="Brave", playing=True):
    return {"app": app, "playing": playing, "title": title, "artist": artist}


def kind(exe, title, sessions=()):
    r = classify(exe, title, list(sessions))
    return r["activity"] + ("+music" if r["music"] and r["activity"] != "music" else "")


def test_coding_apps_and_sites():
    assert kind("code.exe", "main.py - project - Visual Studio Code") == "coding"
    assert kind("windowsterminal.exe", "PowerShell") == "coding"
    assert kind("pycharm64.exe", "app – views.py") == "coding"
    assert kind("brave.exe", "Two Sum - LeetCode - Brave") == "coding"
    assert kind("chrome.exe", "anthropics/claude-code: issues · GitHub - Google Chrome") == "coding"


def test_youtube_in_front_is_watching():
    assert kind("brave.exe", "Funny cats compilation - YouTube - Brave") == "watching"
    assert kind("msedge.exe", "Netflix - Microsoft Edge") == "watching"
    assert kind("vlc.exe", "movie.mkv - VLC media player") == "watching"


def test_songs_playing_are_music_wherever_you_are():
    # The user's real examples.
    assert kind("brave.exe", "x - YouTube - Brave", [song("Raj Karega Khalsa - Full Video | Tiger S, Jacqueline F", "Bollywood Josh Hits 24X7")]) == "music"
    assert kind("brave.exe", "x - YouTube", [song("Fujii Kaze - Shinunoga E-Wa (Not a MV)", "Fujii Kaze")]) == "music"
    assert kind("brave.exe", "x - YouTube", [song("295 (MUSIC VIDEO) SIDHU MOOSE WALA", "Sidhu Moose Wala")]) == "music"
    assert kind("explorer.exe", "Downloads", [song("Best of lofi hip hop 2021 [beats to relax/study to]", "Lofi Girl")]) == "music"
    assert kind("explorer.exe", "Downloads", [song("Kesariya", "Arijit Singh - Topic")]) == "music"
    assert kind("notepad.exe", "notes", [song("Blinding Lights", "The Weeknd", app="Spotify.exe")]) == "music"


def test_a_playing_video_that_isnt_a_song_is_watching():
    assert kind("brave.exe", "x - YouTube", [song("I built a robot in 24 hours", "Mark Rober")]) == "watching"
    assert kind("explorer.exe", "Downloads", [song("Podcast episode 12", "Some Podcast")]) == "watching"


def test_paused_media_doesnt_count():
    assert kind("explorer.exe", "Downloads", [song("Kesariya", "Arijit Singh - Topic", playing=False)]) == "none"


def test_music_while_coding_stays_focused_but_grooves():
    assert kind("code.exe", "x - Visual Studio Code", [song("lofi beats", "Lofi Girl")]) == "coding+music"


def test_other_apps_are_normal():
    assert kind("explorer.exe", "Downloads") == "none"
    assert kind("winword.exe", "Essay.docx - Word") == "none"


# --------------------------------------------------------- watcher behaviour

class Fake:
    def __init__(self):
        self.front = ("explorer.exe", "Downloads")
        self.sessions = []
        self.now = 0.0
        self.events = []
        self.w = activity.ActivityWatcher(self.events.append, read_foreground=lambda: self.front, clock=lambda: self.now)
        self.w.enabled = True

    def tick(self, seconds=2.0):
        self.now += seconds
        self.w.poll(self.sessions)


def test_waits_before_changing_mood_so_alt_tab_doesnt_flicker():
    f = Fake()
    f.tick()  # first look: none, nothing to say
    f.front = ("code.exe", "x - Visual Studio Code")
    f.tick()
    f.front = ("explorer.exe", "Downloads")  # back after 2 s: just a glance at VS Code
    f.tick()
    assert f.events == [], f.events
    f.front = ("code.exe", "x - Visual Studio Code")
    for _ in range(4):
        f.tick()
    assert [e["activity"] for e in f.events] == ["coding"], f.events


def test_clicking_the_robot_doesnt_count():
    f = Fake()
    f.front = ("code.exe", "x - Visual Studio Code")
    f.tick()
    assert [e["activity"] for e in f.events] == ["coding"]
    f.front = ("electron.exe", "Bit")
    for _ in range(5):
        f.tick()
    assert len(f.events) == 1 and f.w.current["activity"] == "coding", f.events


def test_events_carry_only_the_label_never_titles():
    f = Fake()
    f.front = ("brave.exe", "My private chat with someone - WhatsApp - Brave")
    f.sessions = [song("Secret song title", "Some Channel music")]
    f.tick()
    assert f.events and set(f.events[0]) == {"type", "text", "activity", "music"} and f.events[0]["text"] == "", f.events
    assert "Secret" not in str(f.events) and "WhatsApp" not in str(f.events)


def test_switching_off_returns_to_normal():
    f = Fake()
    f.sessions = [song("lofi", "Lofi Girl")]
    f.tick()
    assert f.events[-1]["activity"] == "music"
    f.w.stop()
    assert f.events[-1]["activity"] == "none" and not f.w.enabled


if __name__ == "__main__":
    tests = [(n, fn) for n, fn in sorted(globals().items()) if n.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS  {name}")
        except Exception:
            failed += 1
            print(f"FAIL  {name}")
            traceback.print_exc(limit=3)
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
