"""
Tests for the YouTube and media-control actions (Milestone 5), with a fake
LLM, a fake YouTube API and fake Windows media sessions — nothing here
touches the network or whatever is really playing.

Run:  venv\\Scripts\\python tests\\test_tools.py
"""

import asyncio
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
TMP = Path(tempfile.mkdtemp(prefix="tool-tests-"))
os.environ["REMINDER_DB_PATH"] = str(TMP / "test.db")

import httpx  # noqa: E402

import actions  # noqa: E402
import agent  # noqa: E402
import conversation  # noqa: E402
import media  # noqa: E402
import memory  # noqa: E402

media.ISOLATE = False  # fake media sessions live in this process
import reminders  # noqa: E402
import youtube  # noqa: E402

LLM_REPLIES: list = []


async def fake_llm(prompt: str) -> str:
    return json.dumps(LLM_REPLIES.pop(0))


ROUTER = agent._call_llm  # the real lane router, tested below with fake providers
agent._call_llm = fake_llm
reminders.init_tables()
conversation.init_tables()


def say(text, reply):
    LLM_REPLIES.append(reply)
    return asyncio.run(conversation.converse(text))


# ------------------------------------------------------------ fake YouTube API

API_CALLS: list = []


def fake_api(response: httpx.Response):
    def handler(request: httpx.Request) -> httpx.Response:
        API_CALLS.append(request)
        return response

    real = httpx.AsyncClient
    youtube.httpx.AsyncClient = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    return real


def with_api(key, response, fn):
    API_CALLS.clear()
    real = fake_api(response)
    old_key, youtube.YOUTUBE_API_KEY = youtube.YOUTUBE_API_KEY, key
    try:
        return fn()
    finally:
        youtube.httpx.AsyncClient = real
        youtube.YOUTUBE_API_KEY = old_key


VIDEO = {"items": [{"id": {"kind": "youtube#video", "videoId": "jfKfPfyJRdk"},
                    "snippet": {"title": "lofi hip hop radio &#39;beats to relax/study to&#39; | 24/7", "channelTitle": "Lofi Girl"}}]}


def test_play_without_key_opens_search_results():
    r = with_api("", httpx.Response(500), lambda: say("play lofi on youtube", {"say": "Playing lofi!", "mood": "excited", "action": {"type": "youtube", "query": "lofi music", "play": True}}))
    url = urlparse(r["open_url"])
    assert url.hostname == "www.youtube.com" and url.path == "/results" and parse_qs(url.query) == {"search_query": ["lofi music"]}, r
    assert API_CALLS == [], "called the API without a key"
    assert "Playing" not in r["say"] and "lofi music" in r["say"] and not r["applied"], r


def test_play_with_key_opens_the_video():
    r = with_api("test-key", httpx.Response(200, json=VIDEO), lambda: say("play lofi", {"say": "ok", "mood": "excited", "action": {"type": "youtube", "query": "lofi", "play": True}}))
    assert r["open_url"] == "https://www.youtube.com/watch?v=jfKfPfyJRdk", r
    assert r["say"] == "Playing \"lofi hip hop radio 'beats to relax/study to'\" on YouTube.", r
    req = API_CALLS[0]
    assert req.headers["x-goog-api-key"] == "test-key" and "key=" not in str(req.url), "key must go in a header, not the URL"
    assert parse_qs(req.url.query.decode())["q"] == ["lofi"], req.url


def test_quota_used_up_falls_back_to_results():
    r = with_api("test-key", httpx.Response(403, json={"error": {"code": 403}}), lambda: say("play lofi", {"say": "ok", "mood": "happy", "action": {"type": "youtube", "query": "lofi", "play": True}}))
    assert urlparse(r["open_url"]).path == "/results", r


def test_find_videos_never_autoplays():
    r = with_api("test-key", httpx.Response(200, json=VIDEO), lambda: say("find videos about recursion", {"say": "ok", "mood": "curious", "action": {"type": "youtube", "query": "recursion explained", "play": False}}))
    assert urlparse(r["open_url"]).path == "/results" and API_CALLS == [], r


def test_strange_video_ids_are_refused():
    bad = {"items": [{"id": {"videoId": "x\"><script>"}, "snippet": {"title": "t"}}]}
    r = with_api("test-key", httpx.Response(200, json=bad), lambda: say("play x", {"say": "ok", "mood": "happy", "action": {"type": "youtube", "query": "x", "play": True}}))
    assert urlparse(r["open_url"]).path == "/results", r


def test_empty_query_asks_instead():
    r = say("play something on youtube", {"say": "Sure!", "mood": "happy", "action": {"type": "youtube", "query": "  ", "play": True}})
    assert r["open_url"] is None and "What should I look up" in r["say"], r


def test_ordinary_chat_opens_nothing():
    r = say("hi", {"say": "Hello!", "mood": "happy", "action": None})
    assert r["open_url"] is None and r["say"] == "Hello!", r


def test_long_titles_are_shortened_for_speech():
    assert youtube.spoken_title("Raj Karega Khalsa - Full Video | Tiger S, Jacqueline F | Dabangg") == "Raj Karega Khalsa - Full Video"
    assert youtube.spoken_title("📚 lofi hip hop radio 🎧 beats to study to") == "lofi hip hop radio beats to study to"
    long = youtube.spoken_title("a " * 50)
    assert len(long) <= 61 and long.endswith("…"), long


# --------------------------------------------------- fake Windows media sessions

class FakeProps:
    def __init__(self, title, artist):
        self.title, self.artist = title, artist


class FakeInfo:
    def __init__(self, status):
        self.playback_status = status


class FakeSession:
    def __init__(self, app, status, title="Song", artist="Artist", can_skip=True):
        self.source_app_user_model_id = app
        self.status, self.title, self.artist, self.can_skip = status, title, artist, can_skip
        self.calls = []

    def get_playback_info(self):
        return FakeInfo(self.status)

    async def try_get_media_properties_async(self):
        return FakeProps(self.title, self.artist)

    async def try_pause_async(self):
        self.calls.append("pause")
        self.status = media.PAUSED
        return True

    async def try_play_async(self):
        self.calls.append("play")
        self.status = media.PLAYING
        return True

    async def try_skip_next_async(self):
        self.calls.append("next")
        return self.can_skip

    async def try_skip_previous_async(self):
        self.calls.append("previous")
        return self.can_skip


class FakeManager:
    def __init__(self, sessions, current=None):
        self.sessions, self.current = sessions, current

    def get_sessions(self):
        return self.sessions

    def get_current_session(self):
        return self.current


KEYS: list = []
media.press_key = lambda vk, times=1: KEYS.append((vk, times))


def use(manager):
    async def get():
        return manager
    media.get_manager = get
    KEYS.clear()


def cmd(text, command):
    return say(text, {"say": "Done!", "mood": "happy", "action": {"type": "media", "command": command}})


def test_pause_pauses_what_is_playing_only():
    yt, spotify = FakeSession("Brave", media.PLAYING), FakeSession("Spotify.exe", media.PAUSED)
    use(FakeManager([yt, spotify], current=spotify))
    r = cmd("pause", "pause")
    assert yt.calls == ["pause"] and spotify.calls == [] and r["say"] == "Paused." and r["open_url"] is None, (r, yt.calls, spotify.calls)


def test_pause_when_nothing_plays_never_starts_music():
    yt = FakeSession("Brave", media.PAUSED)
    use(FakeManager([yt], current=yt))
    r = cmd("pause", "pause")
    assert yt.calls == [] and KEYS == [] and "Nothing" in r["say"], r


def test_resume_plays_the_paused_one():
    yt = FakeSession("Brave", media.PAUSED)
    use(FakeManager([yt], current=yt))
    r = cmd("resume the music", "resume")
    assert yt.calls == ["play"] and r["say"] == "Playing again.", r
    r = cmd("play", "play")
    assert yt.calls == ["play"] and "already" in r["say"], r


def test_next_and_unskippable():
    yt = FakeSession("Brave", media.PLAYING, can_skip=False)
    use(FakeManager([yt], current=yt))
    r = cmd("next song", "next")
    assert yt.calls == ["next"] and "Brave won't let me skip" in r["say"], r


class FakeControls:
    def __init__(self, nxt, prev, seek):
        self.is_next_enabled, self.is_previous_enabled, self.is_playback_position_enabled = nxt, prev, seek


class FakeTimeline:
    def __init__(self, seconds):
        from datetime import timedelta
        self.min_seek_time = self.start_time = timedelta(0)
        self.max_seek_time = self.end_time = timedelta(seconds=seconds)


class SingleVideo(FakeSession):
    """A lone YouTube video in Brave: no next/previous buttons, but seekable."""

    def __init__(self, seconds=362.5, seek=True):
        super().__init__("Brave", media.PLAYING)
        self.seconds, self.seek, self.seeks = seconds, seek, []

    def get_playback_info(self):
        info = FakeInfo(self.status)
        info.controls = FakeControls(False, False, self.seek)
        return info

    def get_timeline_properties(self):
        return FakeTimeline(self.seconds)

    async def try_change_playback_position_async(self, ticks):
        self.seeks.append(ticks / 10_000_000)
        return True


def test_skip_a_single_video_jumps_to_the_end():
    yt = SingleVideo()
    use(FakeManager([yt], current=yt))
    r = cmd("skip this video", "next")
    assert yt.calls == [] and yt.seeks == [362.0] and "Autoplay" in r["say"], (r, yt.calls, yt.seeks)
    r = cmd("go back", "previous")
    assert yt.calls == [] and yt.seeks[-1] == 0 and r["say"] == "Back to the start.", (r, yt.seeks)


def test_skip_a_live_stream_says_it_cant():
    for yt in (SingleVideo(seconds=0), SingleVideo(seek=False)):
        use(FakeManager([yt], current=yt))
        r = cmd("skip", "next")
        assert yt.calls == [] and yt.seeks == [] and "won't let me skip" in r["say"], r


def test_whats_playing_is_answered_locally():
    yt = FakeSession("Brave", media.PLAYING, title="Lofi beats", artist="Lofi Girl")
    use(FakeManager([yt], current=yt))
    r = cmd("what's playing?", "status")
    assert r["say"] == "That's \"Lofi beats\" by Lofi Girl in Brave, playing.", r


def test_volume_uses_keys():
    use(FakeManager([]))
    r = cmd("turn it up", "volume_up")
    assert KEYS == [(media.VK["volume_up"], media.VOLUME_STEPS)] and r["say"] == "Turned it up.", r


def test_without_media_sessions_falls_back_to_keys():
    use(None)
    r = cmd("pause", "pause")
    assert KEYS == [(media.VK["toggle"], 1)] and r["say"] == "Pressed pause.", r
    r = cmd("what's playing", "status")
    assert "can't see" in r["say"], r


def test_unknown_media_command_explains():
    use(FakeManager([]))
    r = cmd("rewind 10 seconds", "rewind")
    assert not r["applied"] and "I can play, pause" in r["say"] and KEYS == [], r


def test_app_names():
    assert media.app_name("Brave") == "Brave"
    assert media.app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify") == "Spotify"
    assert media.app_name("MSEdge") == "Edge"
    assert media.app_name("Some.App!Player") == "Player"


# ------------------------------------------------- conversation: keep listening?

def test_chatting_keeps_the_conversation_going():
    r = say("I'm bored", {"say": "Same here sometimes. Want to hear a fun fact", "mood": "curious", "action": None, "follow_up": True})
    assert r["follow_up"] and not r["quiet"], r
    r = say("ok thanks, that's all", {"say": "Anytime!", "mood": "happy", "action": None, "follow_up": False})
    assert not r["follow_up"], r


def test_a_question_always_waits_for_the_answer():
    r = say("hmm", {"say": "What are you working on today?", "mood": "curious", "action": None, "follow_up": False})
    assert r["follow_up"], r


def test_tasks_are_done_quietly_and_end_the_conversation():
    use(FakeManager([FakeSession("Brave", media.PLAYING)]))
    r = say("pause", {"say": "Pausing!", "mood": "happy", "action": {"type": "media", "command": "pause"}, "follow_up": True})
    assert r["quiet"] and not r["follow_up"], r
    r = with_api("", httpx.Response(500), lambda: say("play lofi", {"say": "ok", "mood": "excited", "action": {"type": "youtube", "query": "lofi", "play": True}, "follow_up": True}))
    assert r["quiet"] and not r["follow_up"], r
    r = say("remind me to stretch at 5pm", {"say": "Got it.", "mood": "happy", "action": {"type": "add", "title": "Stretch", "time": "17:00"}, "follow_up": True})
    assert r["applied"] and not r["quiet"] and not r["follow_up"], r  # a reminder is confirmed out loud, then done


def test_whats_playing_is_answered_out_loud():
    use(FakeManager([FakeSession("Brave", media.PLAYING, title="Lofi beats")]))
    r = say("what's playing", {"say": "x", "mood": "happy", "action": {"type": "media", "command": "status"}})
    assert not r["quiet"] and "Lofi beats" in r["say"], r


def test_delete_confirmation_waits_for_yes():
    actions._pending = None
    item = reminders.add_item("Gym", "today", "18:00")
    r = say("delete gym", {"say": "Deleting!", "mood": "neutral", "action": {"type": "delete", "id": item}})
    assert r["follow_up"] and "Say yes" in r["say"], r
    r = say("yes", "THE LLM MUST NOT BE CALLED")
    assert r["applied"] and not r["follow_up"], r
    LLM_REPLIES.clear()


def test_offline_ends_the_conversation():
    async def down(prompt):
        raise RuntimeError("all providers failed")
    agent._call_llm = down
    try:
        r = asyncio.run(conversation.converse("tell me something"))
        assert r["offline"] and not r["follow_up"], r
    finally:
        agent._call_llm = fake_llm


# ------------------------------------------------------------------ morning hello

import briefing  # noqa: E402
import occasions  # noqa: E402


def test_morning_hello_uses_tasks_weather_and_special_days():
    from datetime import date as _d
    today = _d.today().isoformat()
    reminders.add_item("Revise graphs", today, "19:00")
    reminders.add_item("Gym", today, "07:30")
    prompts = []

    async def fake_answer(query, question):
        return True, "It's 24 degrees and sunny.", None
    async def capture(prompt):
        prompts.append(prompt)
        return "SAY: Good morning! Sunny and 24, and you've got two things today."
    real = (web.answer, agent._call_llm, occasions.today)
    web.answer, agent._call_llm = fake_answer, capture
    occasions.today = lambda on=None: {"emoji": "🎂", "label": "Happy birthday!", "birthday": True}
    try:
        r = asyncio.run(briefing.morning("Bit"))
        assert r["say"].startswith("Good morning!") and "two things" in r["say"], r
        # Only the number is spoken: the model never even sees the titles.
        p = prompts[-1]
        assert "Number of tasks today: 2" in p and "Happy birthday!" in p and "24 degrees" in p, p
        assert "Gym" not in p and "Revise graphs" not in p, p
        # The list itself is in the panel, earliest first.
        assert r["details"].index("07:30 — Gym") < r["details"].index("19:00 — Revise graphs"), r
    finally:
        web.answer, agent._call_llm, occasions.today = real


def test_morning_hello_without_any_model():
    async def down_answer(query, question):
        return False, "I couldn't search", None
    async def down(prompt):
        raise RuntimeError("all lanes busy")
    real = (web.answer, agent._call_llm)
    web.answer, agent._call_llm = down_answer, down
    try:
        r = asyncio.run(briefing.morning("Bit"))
        assert "things today" in r["say"] or "one thing today" in r["say"] or "Nothing on your list" in r["say"], r
        assert "Gym" not in r["say"] and "Revise graphs" not in r["say"], "the template says the number only"
    finally:
        web.answer, agent._call_llm = real


def test_morning_count_in_words():
    assert briefing._count_words(0) == "Nothing on your list today."
    assert briefing._count_words(1) == "You have one thing today."
    assert briefing._count_words(3) == "You have three things today."
    assert briefing._count_words(14) == "You have 14 things today."


def test_check_in_goes_into_the_conversation():
    conversation.add_note("You've been coding for an hour and a half. Stretch?")
    assert conversation.recent_messages(1)[0]["text"].startswith("You've been coding"), conversation.recent_messages(1)
    state = memory.thread_state(memory.current_thread())
    assert state["messages"][-1].content.startswith("You've been coding")


# ------------------------------------------------------------------ mood

def test_mood_colours_the_prompt():
    prompts = []

    async def capture(prompt):
        prompts.append(prompt)
        return json.dumps({"say": "Hi!", "mood": "happy", "action": None})
    agent._call_llm = capture
    try:
        asyncio.run(conversation.converse("hello", mood="a bit bored (nobody's talked to you for a while)"))
        assert any("How you feel right now: a bit bored" in p for p in prompts), "mood missing from the reply prompt"
        prompts.clear()
        asyncio.run(conversation.converse("hello"))
        assert not any("How you feel right now" in p for p in prompts)
    finally:
        agent._call_llm = fake_llm


# ------------------------------------------------------------------ games

import games  # noqa: E402


def test_rock_paper_scissors_is_fair_and_keeps_playing():
    games.score.update(bit=0, you=0)
    picks = iter(["paper", "rock", "scissors"])
    games.rng.choice = lambda options: next(picks) if options == games.RPS else options[0]
    r = say("rock!", {"say": "I win!", "mood": "happy", "action": {"type": "game", "name": "rps", "choice": "rock"}})
    assert "I picked paper, so I win" in r["say"] and r["move"] == "dance" and r["follow_up"], r  # "Again?" keeps listening
    r = say("paper", {"say": "", "mood": "happy", "action": {"type": "game", "name": "rps", "choice": "paper"}})
    assert "I picked rock. You win" in r["say"] and r["move"] == "bow", r
    r = say("stone", {"say": "", "mood": "happy", "action": {"type": "game", "name": "rps", "choice": "stone"}})
    assert "I picked scissors. You win" in r["say"] and "2 to 1" in r["say"], r
    games.rng = __import__("random").Random()
    games.expect_rps(False)  # (no game left running for the next test)
    LLM_REPLIES.clear()


def test_rps_uses_your_own_word():
    games.rng.choice = lambda options: "rock" if options == games.RPS else options[0]
    r = say("scissors", {"say": "", "mood": "happy", "action": {"type": "game", "name": "rps", "choice": "rock"}})
    assert "I picked rock, so I win" in r["say"], r  # you said scissors, whatever the model passed
    games.rng = __import__("random").Random()
    games.expect_rps(False)  # (no game left running for the next test)
    LLM_REPLIES.clear()


def test_mid_game_pick_never_reaches_the_model():
    games.rng.choice = lambda options: "paper" if options == games.RPS else options[0]
    say("let's play rock paper scissors", {"say": "Rock, paper, or scissors?", "mood": "happy", "action": None})
    r = say("scissors!", "THE MODEL MUST NOT SEE THE PICK")
    assert "I picked paper. You win" in r["say"] and r["follow_up"], r
    assert LLM_REPLIES == ["THE MODEL MUST NOT SEE THE PICK"], "the pick went to the model"
    LLM_REPLIES.clear()
    games.expect_rps(False)
    games.rng = __import__("random").Random()
    games.expect_rps(False)  # (no game left running for the next test)
    LLM_REPLIES.clear()


def test_rps_without_a_pick_asks():
    r = say("let's play rock paper scissors", {"say": "", "mood": "happy", "action": {"type": "game", "name": "rps", "choice": None}})
    assert r["say"].endswith("Rock, paper or scissors?") and r["follow_up"], r


def test_coin_and_dice():
    r = say("flip a coin", {"say": "", "mood": "happy", "action": {"type": "game", "name": "coin"}})
    assert r["say"] in ("It's heads!", "It's tails!") and r["move"] == "spin" and not r["follow_up"], r
    r = say("roll a dice", {"say": "", "mood": "happy", "action": {"type": "game", "name": "dice"}})
    assert r["say"].startswith("You rolled a ") and 1 <= int(r["say"][-2]) <= 6, r


# ------------------------------------------------------------------ focus timer

def test_focus_timer_start_and_stop():
    r = say("focus for 45 minutes", {"say": "", "mood": "happy", "action": {"type": "focus", "minutes": "45"}})
    assert r["focus"] == {"minutes": 45} and "45 minutes" in r["say"] and not r["applied"] and not r["follow_up"], r
    r = say("start a pomodoro", {"say": "", "mood": "happy", "action": {"type": "focus"}})
    assert r["focus"] == {"minutes": 25}, r
    r = say("stop the timer", {"say": "", "mood": "neutral", "action": {"type": "focus", "stop": True}})
    assert r["focus"] == {"stop": True} and "stopped" in r["say"], r


def test_focus_state_reaches_the_prompt():
    prompts = []

    async def capture(prompt):
        prompts.append(prompt)
        return json.dumps({"say": "12 minutes.", "mood": "neutral", "action": None})
    agent._call_llm = capture
    try:
        asyncio.run(conversation.converse("how long is left?", focus="A focus session is running: 12 minutes left (1 focus session done today)."))
        assert any("A focus session is running: 12 minutes left" in p for p in prompts)
    finally:
        agent._call_llm = fake_llm


# ------------------------------------------------------------------ moves on request

def test_do_a_backflip():
    r = say("do a backflip", {"say": "Okay!", "mood": "excited", "action": {"type": "move", "name": "Backflip"}, "follow_up": True})
    assert r["move"] == "backflip" and r["say"] == "Okay!" and not r["follow_up"] and not r["applied"], r


def test_unknown_move_explains():
    r = say("do a cartwheel", {"say": "Sure!", "mood": "happy", "action": {"type": "move", "name": "cartwheel"}})
    assert r["move"] is None and "can't do that one" in r["say"] and "backflip" in r["say"], r


# ------------------------------------------------------------------ web search

import web  # noqa: E402

SEARCHES: list = []


def fake_search(result):
    async def search(prompt):
        SEARCHES.append(prompt)
        if isinstance(result, Exception):
            raise result
        return result
    agent.call_search = search
    SEARCHES.clear()


def test_search_answers_out_loud_with_sources():
    fake_search({
        "text": "SAY: It's 24 degrees and partly cloudy in New Delhi right now【1†L5-L9】.\nDETAILS:\n- Humidity 76%\n- Light winds",
        "sources": [{"title": "Weather - Delhi", "url": "https://weather.example.com/delhi"},
                    {"title": "dupe", "url": "https://weather.example.com/other"},
                    {"title": "Bad", "url": "javascript:alert(1)"},
                    {"title": "Local", "url": "https://127.0.0.1/x"},
                    {"title": "IMD", "url": "https://mausam.imd.gov.in/"}],
    })
    first = say("what's the weather in delhi", {"say": "It's sunny!", "mood": "happy", "action": {"type": "search", "query": "weather New Delhi now"}, "follow_up": True})
    assert first["say"] in conversation.LOOKING and first["search"] == {"query": "weather New Delhi now", "question": "what's the weather in delhi"}, first
    assert not first["follow_up"] and not first["quiet"] and SEARCHES == [], "step one only says it's looking"
    r = asyncio.run(conversation.search_answer(first["search"]["query"], first["search"]["question"]))
    assert r["say"] == "It's 24 degrees and partly cloudy in New Delhi right now.", r
    assert "Humidity 76%" in r["details"] and "[Weather - Delhi](https://weather.example.com/delhi)" in r["details"], r
    assert "dupe" not in r["details"] and "javascript" not in r["details"] and "127.0.0.1" not in r["details"] and "mausam.imd.gov.in" in r["details"], r
    assert not r["follow_up"] and not r["applied"], r
    assert "what's the weather in delhi" in SEARCHES[0], "the user's own question should be searched"
    history = conversation.recent_messages(4)
    assert history[-1]["text"] == r["say"] and all(m["text"] not in conversation.LOOKING for m in history), history


def test_search_without_the_format_still_answers():
    fake_search({"text": "Australia won the 2023 final. They beat India by six wickets. It was in Ahmedabad.", "sources": []})
    r = asyncio.run(conversation.search_answer("cricket world cup winner", "who won the last world cup"))
    assert r["say"] == "Australia won the 2023 final. They beat India by six wickets." and "Ahmedabad" in (r["details"] or ""), r


def test_search_down_says_so():
    fake_search(RuntimeError("all lanes busy"))
    r = asyncio.run(conversation.search_answer("latest news India", "latest news"))
    assert "couldn't search" in r["say"] and r["details"] is None and not r["ok"], r


def test_google_it_opens_results_even_if_the_model_forgets():
    fake_search({"text": "should not be called", "sources": []})
    r = say("google best biryani in Hyderabad", {"say": "", "mood": "happy", "action": {"type": "search", "query": "best biryani in Hyderabad", "open": False}})
    assert r["open_url"] == "https://www.google.com/search?q=best+biryani+in+Hyderabad" and r["quiet"] and r["search"] is None, r


def test_google_it_opens_results_quietly():
    fake_search({"text": "should not be called", "sources": []})
    r = say("google best pizza near me", {"say": "", "mood": "happy", "action": {"type": "search", "query": "best pizza near me", "open": True}})
    assert r["open_url"] == "https://www.google.com/search?q=best+pizza+near+me" and r["quiet"] and SEARCHES == [], r


def test_parse_handles_odd_replies():
    assert web.parse("SAY: Hi there.\nDETAILS: none") == ("Hi there.", None)
    assert web.parse("say:   It is 5 PM [1].") == ("It is 5 PM.", None), web.parse("say:   It is 5 PM [1].")


# ------------------------------------------------------- LLM lanes (free tiers)

def lanes_with(responses: dict):
    """Fake providers: responses[lane] is text, or an int HTTP status to fail with."""
    calls = []
    real_gemini, real_groq = agent._call_gemini, agent._call_groq

    def fake(provider):
        async def call(prompt, model):
            lane = f"{provider}:{model}"
            calls.append(lane)
            r = responses[lane]
            if isinstance(r, int):
                headers = {"retry-after": "30"} if provider == "groq" else {}
                body = {"error": {"details": [{"retryDelay": "2479s"}]}} if provider == "gemini" else {}
                raise httpx.HTTPStatusError("x", request=httpx.Request("POST", "http://x"), response=httpx.Response(r, headers=headers, json=body))
            return r
        return call

    agent._call_gemini, agent._call_groq = fake("gemini"), fake("groq")
    agent._resting.clear()
    old = (agent.LANES, agent.GEMINI_API_KEY, agent.GROQ_API_KEY)
    agent.LANES = [("groq", "a"), ("gemini", "b"), ("groq", "c")]
    agent.GEMINI_API_KEY = agent.GROQ_API_KEY = "k"

    def restore():
        agent._call_gemini, agent._call_groq = real_gemini, real_groq
        agent.LANES, agent.GEMINI_API_KEY, agent.GROQ_API_KEY = old
        agent._resting.clear()
    return calls, restore


def test_busy_lane_is_skipped_until_it_resets():
    calls, restore = lanes_with({"groq:a": 429, "gemini:b": "from b", "groq:c": "from c"})
    try:
        assert asyncio.run(ROUTER("hi")) == "from b" and calls == ["groq:a", "gemini:b"], calls
        calls.clear()
        assert asyncio.run(ROUTER("hi")) == "from b" and calls == ["gemini:b"], calls  # a is resting (30 s)
        assert 25 < agent._resting["groq:a"] - time.time() <= 30
    finally:
        restore()


def test_gemini_daily_quota_rests_until_its_reset_time():
    calls, restore = lanes_with({"groq:a": 429, "gemini:b": 429, "groq:c": "from c"})
    try:
        assert asyncio.run(ROUTER("hi")) == "from c", calls
        assert agent._resting["gemini:b"] - time.time() > 2400  # "retryDelay": "2479s"
    finally:
        restore()


def test_everything_busy_still_tries_the_soonest():
    calls, restore = lanes_with({"groq:a": "ok now", "gemini:b": 429, "groq:c": 429})
    try:
        now = time.time()
        agent._resting.update({"groq:a": now + 5, "gemini:b": now + 900, "groq:c": now + 60})
        assert asyncio.run(ROUTER("hi")) == "ok now" and calls == ["groq:a"], calls
    finally:
        restore()


def test_retired_model_and_bad_key_rest_long():
    calls, restore = lanes_with({"groq:a": 404, "gemini:b": 401, "groq:c": "fine"})
    try:
        assert asyncio.run(ROUTER("hi")) == "fine"
        t = time.time()
        assert agent._resting["groq:a"] - t > 80000 and agent._resting["gemini:b"] - t > 3000
    finally:
        restore()


# ---------------------------------------------------------------------- runner

# ------------------------------------------------------- "help me with this"

import base64  # noqa: E402
from datetime import date, timedelta  # noqa: E402

import vision  # noqa: E402

JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\0" * 200).decode()  # just the header the check looks at
VISION_PROMPTS: list = []


def fake_vision(text):
    async def call(prompt, image_b64, mime="image/jpeg"):
        VISION_PROMPTS.append((prompt, image_b64, mime))
        agent.last_lane = "gemini:gemini-3.5-flash-lite"
        return text
    agent.call_vision = call
    VISION_PROMPTS.clear()


def test_help_me_with_this_looks_without_the_chat_model():
    LLM_REPLIES.clear()
    before = len(conversation.recent_messages(100))
    for text in ("hey help me with this", "what does this error mean?", "look at my screen"):
        LLM_REPLIES.append({"say": "unused", "mood": "happy", "action": None})
        r = asyncio.run(conversation.converse(text))
        assert r["look"] == {"question": text} and r["say"] in conversation.PEEKING and r["mood"] == "thinking", r
        assert not r["follow_up"] and not r["applied"] and not r["quiet"], r
        assert len(LLM_REPLIES) == 1, "a screen question shouldn't wait for the chat model first"
        LLM_REPLIES.clear()
    # Only the user's messages are logged; the answer comes from look_answer.
    assert len(conversation.recent_messages(100)) == before + 3


def test_reminders_about_the_screen_stay_reminders():
    r = say("remind me to look at the screen tomorrow at 9", {"say": "Okay, I'll remind you.", "mood": "happy", "action": None})
    assert r["look"] is None and r["say"] == "Okay, I'll remind you.", r


def test_the_model_can_ask_for_a_look():
    r = say("why is my code not compiling?", {"say": "", "mood": "curious", "action": {"type": "look", "question": "why won't my code compile"}})
    assert r["look"] == {"question": "why won't my code compile"} and r["say"] in conversation.PEEKING, r


def test_look_answer_is_spoken_remembered_and_says_where_the_picture_went():
    fake_vision("SAY: That's a KeyError: chemistry isn't in your marks dictionary.\nDETAILS: Add `'chemistry': 85` to `marks`.\nSEEN: a Python KeyError in VS Code")
    r = asyncio.run(conversation.look_answer(JPEG, "image/jpeg", "help me with this"))
    # It keeps listening and keeps looking: the next question comes with a fresh screenshot.
    assert r["ok"] and r["say"] == "That's a KeyError: chemistry isn't in your marks dictionary." and r["follow_up"] and r["screen_mode"], r
    # One short line says where the screenshot went, and how to stop.
    note = r["details"].split("\n\n")[-1]
    assert "'chemistry': 85" in r["details"] and note.startswith("📸 Screenshot sent to Google Gemini (Bit doesn't save it).") and "stop looking" in note, r
    assert r["details"].count("📸") == 1 and "👀" not in r["details"], r
    prompt, image, mime = VISION_PROMPTS[0]
    assert image == JPEG and mime == "image/jpeg" and '"help me with this"' in prompt
    assert conversation.recent_messages(1)[0]["text"] == r["say"]
    # The model's memory has what was on screen, so "how do I fix it?" works next.
    last = memory.thread_state(memory.current_thread())["messages"][-1].content
    assert "Looked at the user's screen: a Python KeyError in VS Code" in last and "'chemistry': 85" in last and "📸" not in last, last


def test_look_rejects_non_images_and_survives_a_dead_model():
    fake_vision("SAY: should not be called")
    r = asyncio.run(conversation.look_answer(base64.b64encode(b"not an image").decode(), "image/jpeg", "help"))
    assert not r["ok"] and VISION_PROMPTS == [] and "clear look" in r["say"], r
    r = asyncio.run(conversation.look_answer(JPEG, "image/gif", "help"))
    assert not r["ok"] and VISION_PROMPTS == [], r

    async def down(prompt, image_b64, mime="image/jpeg"):
        raise RuntimeError("all lanes failed")
    agent.call_vision = down
    r = asyncio.run(conversation.look_answer(JPEG, "image/jpeg", "help"))
    assert not r["ok"] and "couldn't reach" in r["say"], r


def test_vision_parse_tolerates_loose_formats():
    assert vision.parse("SAY: Hi there.\nDETAILS: none\nSEEN: a login page") == ("Hi there.", None, "a login page")
    say_, details, seen = vision.parse("It's a 404 page. The link is broken. Try the home page.")
    assert say_ == "It's a 404 page. The link is broken." and "home page" in details and seen == "", (say_, details, seen)


def test_follow_ups_while_looking_see_the_screen():
    LLM_REPLIES.clear()
    fake_vision(json.dumps({"say": "Line 3 asks for chemistry, which isn't in marks.", "details": "Use `marks.get(subject, 0)`.",
                            "mood": "happy", "action": None, "follow_up": True}))
    r = asyncio.run(conversation.converse("why is it crashing?", source="voice", image=JPEG))
    prompt, image, mime = VISION_PROMPTS[0]
    assert image == JPEG and "You can SEE the user's screen" in prompt and "why is it crashing?" in prompt, prompt[-300:]
    assert r["say"] == "Line 3 asks for chemistry, which isn't in marks." and r["follow_up"] and r["screen_mode"] is True and r["look"] is None, r
    # The fix stays in the model's memory for "and line 5?" (the details, not the picture).
    last = memory.thread_state(memory.current_thread())["messages"][-1].content
    assert "marks.get(subject, 0)" in last, last


def test_while_looking_help_me_with_this_goes_to_the_eyes_not_another_screenshot():
    fake_vision(json.dumps({"say": "That's a for loop over your subjects.", "mood": "happy", "action": None, "follow_up": True}))
    r = asyncio.run(conversation.converse("help me with this", image=JPEG))
    assert r["look"] is None and r["say"] == "That's a for loop over your subjects." and len(VISION_PROMPTS) == 1, r
    fake_vision(json.dumps({"say": "", "mood": "happy", "action": {"type": "look", "question": "x"}}))
    r = asyncio.run(conversation.converse("what's this?", image=JPEG))
    assert r["look"] is None and r["screen_mode"] is True and "What would you like me to do?" in r["say"], r


def test_tasks_still_work_while_looking():
    fake_vision(json.dumps({"say": "Done, I'll remind you.", "mood": "happy", "action": {"type": "add", "title": "Revise DSA", "date": None, "time": "21:00", "in_minutes": None, "repeat": None}}))
    r = asyncio.run(conversation.converse("also remind me to revise DSA at 9 pm", image=JPEG))
    assert r["applied"] and r["screen_mode"] is True and any(o["title"] == "Revise DSA" for o in reminders.occurrences(date.today(), date.today() + timedelta(days=1))), r


def test_stop_looking_needs_no_model():
    LLM_REPLIES.clear()
    fake_vision("SAY: should not be called")
    LLM_REPLIES.append({"say": "unused", "mood": "happy", "action": None})
    for text in ("ok stop looking", "close your eyes"):
        r = asyncio.run(conversation.converse(text, image=JPEG))
        assert r["screen_mode"] is False and r["say"] == conversation.STOPPED_LOOKING and not r["follow_up"], r
    assert VISION_PROMPTS == [] and len(LLM_REPLIES) == 1
    LLM_REPLIES.clear()


def test_casual_stops_while_looking():
    LLM_REPLIES.clear()
    fake_vision("SAY: should not be called")
    for text in ("You can stop now.", "stop", "okay that's it", "thanks, I'm done", "that's all for now"):
        r = asyncio.run(conversation.converse(text, source="voice", image=JPEG))
        assert r["screen_mode"] is False and r["say"] == conversation.STOPPED_LOOKING, (text, r)
    assert VISION_PROMPTS == []
    # Not looking: a plain "stop" is an ordinary message (the model decides what it means).
    LLM_REPLIES.append({"say": "Okay!", "mood": "happy", "action": None})
    r = asyncio.run(conversation.converse("stop"))
    assert r["screen_mode"] is None and not LLM_REPLIES, r
    # Still looking: "stop the music" and "why did it stop?" aren't about the screen.
    for text in ("stop the music", "why did it stop?"):
        fake_vision(json.dumps({"say": "Sure.", "mood": "happy", "action": None}))
        r = asyncio.run(conversation.converse(text, image=JPEG))
        assert r["screen_mode"] is True and len(VISION_PROMPTS) == 1, (text, r)


def test_saying_it_stopped_looking_really_stops():
    fake_vision(json.dumps({"say": "Got it, I'll stop looking at your screen.", "mood": "happy", "action": None}))
    r = asyncio.run(conversation.converse("alright, leave it", image=JPEG))
    assert r["screen_mode"] is False, r
    fake_vision(json.dumps({"say": "Okay!", "mood": "happy", "action": {"type": "look", "stop": True}}))
    r = asyncio.run(conversation.converse("you may rest your eyes", image=JPEG))
    assert r["screen_mode"] is False and r["say"] == conversation.STOPPED_LOOKING, r
    prompt = VISION_PROMPTS[0][0]
    assert '{"type": "look", "stop": true}' in prompt, "the model must know how to stop"


def test_no_screenshot_no_screen_mode_and_a_dead_vision_model_says_so():
    LLM_REPLIES.append({"say": "Hi!", "mood": "happy", "action": None})
    r = asyncio.run(conversation.converse("hello"))
    assert r["screen_mode"] is None, r

    async def down(prompt, image_b64, mime="image/jpeg"):
        raise RuntimeError("all lanes failed")
    agent.call_vision = down
    r = asyncio.run(conversation.converse("why is it crashing?", image=JPEG))
    assert r["offline"] and "couldn't look at your screen" in r["say"], r
    # A broken picture is ignored (an ordinary turn), never sent.
    fake_vision("SAY: should not be called")
    LLM_REPLIES.append({"say": "Hmm?", "mood": "curious", "action": None})
    r = asyncio.run(conversation.converse("and now?", image=base64.b64encode(b"junk").decode()))
    assert VISION_PROMPTS == [] and r["screen_mode"] is None and r["say"] == "Hmm?", r


def test_screenshots_are_never_saved():
    marker = base64.b64encode(b"\xff\xd8\xff\xe0" + b"BIT-SCREEN-MARKER-" * 40).decode()
    fake_vision(json.dumps({"say": "I see it.", "mood": "happy", "action": None}))
    asyncio.run(conversation.converse("what's on line 2?", image=marker))
    assert VISION_PROMPTS and VISION_PROMPTS[0][1] == marker
    m = memory._m()
    m.conn.commit()
    blob = b"".join(f.read_bytes() for f in Path(m.path).parent.glob(Path(m.path).name + "*"))
    blob += b"".join(f.read_bytes() for f in Path(os.environ["REMINDER_DB_PATH"]).parent.glob("*.db*"))
    assert marker[40:120].encode() not in blob, "a screenshot ended up in a database file"


# ------------------------------------------------------- background talk

def test_background_gibberish_is_ignored_without_the_model():
    LLM_REPLIES.clear()
    LLM_REPLIES.append({"say": "unused", "mood": "happy", "action": None})
    before = len(conversation.recent_messages(500))
    for text in ("Paj Shogu. Paj Shogu. Paj Shogu. Paj Shogu", "Bit is a little robot. Bit is a little robot."):
        r = asyncio.run(conversation.converse(text, source="voice"))
        assert r["ignored"] and r["say"] == "" and not r["follow_up"] and r["action"] is None, r
    assert len(LLM_REPLIES) == 1 and len(conversation.recent_messages(500)) == before, "no model call, nothing logged"
    LLM_REPLIES.clear()


def test_repeats_that_people_really_say_are_not_background():
    for text in ("Stop, stop, stop.", "no no no no", "very very very good", "you're a cute little robot", "play the video"):
        assert not conversation.sounds_like_background(text), text
    for text in ("Paj Shogu. Paj Shogu. Paj Shogu.", "ha ha ha ha ha", "I'm a little robot. I'm a little robot. I'm a little robot."):
        assert conversation.sounds_like_background(text), text


def test_the_model_can_decide_it_was_not_for_bit():
    LLM_REPLIES.append({"say": "", "mood": "neutral", "action": {"type": "ignore"}, "follow_up": True})
    r = asyncio.run(conversation.converse("to Cassey Houtom", source="voice"))
    assert r["ignored"] and r["say"] == "" and not r["follow_up"], r
    log = conversation.recent_messages(2)
    assert log[0]["text"] == "to Cassey Houtom" and log[1]["text"] == conversation.IGNORED_NOTE, log
    assert "isn't meant for you" in conversation.HEARD_NOTE


def test_typed_messages_are_never_ignored():
    LLM_REPLIES.append({"say": "", "mood": "neutral", "action": {"type": "ignore"}})
    r = asyncio.run(conversation.converse("asdf qwer", source="typed"))
    assert not r["ignored"] and "not sure what you mean" in r["say"], r
    LLM_REPLIES.append({"say": "Ha, got it.", "mood": "happy", "action": None})
    r = asyncio.run(conversation.converse("Paj Shogu. Paj Shogu. Paj Shogu.", source="typed"))
    assert not r["ignored"] and r["say"] == "Ha, got it.", r


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
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
