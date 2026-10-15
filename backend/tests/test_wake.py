"""
Tests for the "Hey Bit" wake word, fed with speech synthesised by the local
voice (several voices), never the real microphone. Needs the local models
(download_models.py).

Run:  venv\\Scripts\\python tests\\test_wake.py
"""

import io
import sys
import time
import traceback
import wave
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import speech  # noqa: E402
import wake  # noqa: E402

VOICES = ["af_heart", "af_sky", "bf_emma"]
_cache: dict = {}


def say(text: str, voice: str = "af_heart") -> np.ndarray:
    """Synthesised speech as 16 kHz int16."""
    key = (text, voice)
    if key not in _cache:
        with wave.open(io.BytesIO(speech.tts.synthesize(text, voice, 1.0))) as w:
            sr, a = w.getframerate(), np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
        n = int(len(a) * 16000 / sr)
        _cache[key] = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.int16)
    return _cache[key]


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(16000 * seconds), np.int16)


def listen(*parts: np.ndarray, names=None, muted=False, noise=0.0) -> tuple[list[dict], wake.WakeListener, float]:
    events: list[dict] = []
    listener = wake.WakeListener(events.append, lambda a, hint, quality, words: speech.stt.transcribe_pcm(a, quality, hint, words), names)
    listener.set_muted(muted)
    audio = np.concatenate([silence(0.5), *parts, silence(1.5)])
    if noise:
        rng = np.random.default_rng(1)
        audio = np.clip(audio + rng.normal(0, noise, len(audio)), -32768, 32767).astype(np.int16)
    t0 = time.perf_counter()
    for i in range(0, len(audio) - wake.BLOCK + 1, wake.BLOCK):
        listener.feed(audio[i : i + wake.BLOCK])
    return events, listener, time.perf_counter() - t0


def phases(events):
    """What the robot visibly/audibly does. "attention" (a quiet perk-up on the eager tripwire) is allowed anywhere."""
    return [e["phase"] for e in events if e["phase"] != "attention"]


def commands(events):
    return [e["text"] for e in events if e["phase"] == "command"]


def test_hey_bit_with_a_command_in_one_breath():
    for voice in VOICES:
        events, _, _ = listen(say("Hey Bit, play some lofi music.", voice))
        got = commands(events)
        assert len(got) == 1 and "music" in got[0].lower() and "bit" not in got[0].lower(), (voice, events)
        assert phases(events) == ["listening", "command"], (voice, events)  # chimes while you're still talking


def test_near_misses_never_wake_it():
    phrases = ["I ate a bit of bread this morning.", "Hey, but what about tomorrow?", "The habit is hard to break.",
               "Hey Bill, can you call me back?", "We need a bigger bit rate for the video.", "Hey, it's a bit cold today."]
    for voice in VOICES:
        for p in phrases:
            events, listener, _ = listen(say(p, voice))
            assert phases(events) == [], (voice, p, events)  # no chime, no command


def test_bare_name_then_pause_then_command():
    events, _, _ = listen(say("Hey Bit."), silence(2.0), say("What time is it?"))
    assert phases(events) == ["listening", "command"], events
    assert "time" in commands(events)[0].lower(), events


def chime() -> np.ndarray:
    """Roughly the robot's listening chime as the microphone hears it: two short beeps."""
    t = np.arange(int(16000 * 0.09)) / 16000
    beep = lambda f: (np.sin(2 * np.pi * f * t) * 6000).astype(np.int16)
    return np.concatenate([beep(880), beep(1320)])


def test_its_own_chime_doesnt_cancel_the_wait():
    # The name confirmed only when the sentence ends -> the chime plays as the wait begins.
    events, listener, _ = listen(say("Hey Bit."), silence(0.85), chime(), silence(1.5), say("What time is it?"))
    assert phases(events) == ["listening", "command"] and "time" in commands(events)[0].lower(), events


def test_bare_name_then_nothing_cancels():
    events, _, _ = listen(say("Hey Bit."), silence(7.0))
    assert phases(events) == ["listening", "cancel"], events


def test_talking_before_the_name():
    events, _, _ = listen(say("So anyway, hey Bit, pause the music."))
    got = commands(events)
    assert len(got) == 1 and "pause" in got[0].lower() and "anyway" not in got[0].lower(), events


def test_muted_hears_nothing():
    events, listener, _ = listen(say("Hey Bit, play some lofi music."), muted=True)
    assert events == [] and listener.stats["candidates"] == 0, events


def test_works_with_background_noise():
    events, _, _ = listen(say("Hey Bit, what's the weather like?"), noise=300)
    got = commands(events)
    assert len(got) == 1 and "weather" in got[0].lower(), events


def test_renamed_robot_and_bit_still_works():
    events, listener, _ = listen(say("Hey Nova, tell me a joke."), names=["Nova"])
    assert "nova" in listener.names and len(commands(events)) == 1 and "joke" in commands(events)[0].lower(), events
    events, _, _ = listen(say("Hey Bit, tell me a joke."), names=["Nova"])
    assert len(commands(events)) == 1, events


def online_listener(calls):
    """Local Whisper for real; the 'online' service is faked and records what it was sent."""
    def transcribe(audio, hint, quality, words):
        if quality == "online":
            calls.append(len(audio) / 16000)
            return {"text": "Hey Bit, play CarryMinati videos."}
        return speech.stt.transcribe_pcm(audio, quality, hint, words)
    events: list = []
    listener = wake.WakeListener(events.append, transcribe)
    listener.quality = "online"
    return listener, events


def feed(listener, audio):
    audio = np.concatenate([silence(0.5), audio, silence(1.5)])
    for i in range(0, len(audio) - wake.BLOCK + 1, wake.BLOCK):
        listener.feed(audio[i : i + wake.BLOCK])


def test_online_gets_only_the_command():
    calls: list = []
    listener, events = online_listener(calls)
    chat = say("I was telling my friend about the weekend plans.")  # someone talking before the name
    feed(listener, np.concatenate([chat, silence(0.3), say("Hey Bit, play carry minati videos.")]))
    assert commands(events) == ["play CarryMinati videos"], events
    command_len = len(say("Hey Bit, play carry minati videos.")) / 16000
    assert len(calls) == 1 and calls[0] < command_len + 2.0, (calls, command_len)  # not the earlier chat


def test_online_never_sees_false_alarms():
    calls: list = []
    listener, events = online_listener(calls)
    for p in ["I ate a bit of bread this morning.", "Hey Bill, can you call me back?", "Hey, it's a bit cold today."]:
        feed(listener, say(p))
    assert phases(events) == [] and calls == [], (events, calls)


def test_odd_names_are_ignored_safely():
    listener = wake.WakeListener(lambda e: None, lambda a, h, q, w: {"text": ""}, ["R2-D2", "", "x"])
    assert listener.names == ["bit"], listener.names


def test_attention_comes_first_then_one_chime():
    events, _, _ = listen(say("Hey Bit, what's the time?"))
    order = [e["phase"] for e in events]
    assert order[0] == "attention" and order.count("listening") == 1 and order[-1] == "command", order


def test_says_whether_you_are_still_talking():
    # Confirmed mid-sentence: no chime on top of your words. A bare "Hey Bit": chime, then wait.
    events, _, _ = listen(say("Hey Bit, play some lofi music."))
    assert [e.get("speaking") for e in events if e["phase"] == "listening"] == [True], events
    events, _, _ = listen(say("Hey Bit."), silence(2.0), say("What time is it?"))
    assert [e.get("speaking") for e in events if e["phase"] == "listening"] == [False], events


def test_a_thinking_pause_doesnt_cut_the_command():
    events, _, _ = listen(say("Hey Bit, remind me to"), silence(0.9), say("call mom at seven tonight."))
    got = commands(events)
    assert len(got) == 1 and "remind" in got[0].lower() and "mom" in got[0].lower(), events


def mishearing_listener(calls):
    """The quick model mishears the name (as it can over music); the bigger one is real."""
    def transcribe(audio, hint, quality, words):
        calls.append(quality)
        if quality == "fast":
            return {"text": "Hey, but play some lofi music.", "words": []}
        return speech.stt.transcribe_pcm(audio, quality, hint, words)
    events: list = []
    return wake.WakeListener(events.append, transcribe), events


def test_bigger_model_gets_a_second_listen_over_noise():
    calls: list = []
    listener, events = mishearing_listener(calls)
    rng = np.random.default_rng(4)
    audio = np.concatenate([silence(1.0), say("Hey Bit, play some lofi music.")])
    feed(listener, np.clip(audio + rng.normal(0, 400, len(audio)), -32768, 32767).astype(np.int16))
    assert len(commands(events)) == 1 and "music" in commands(events)[0].lower(), events
    assert "accurate" in calls and listener.stats["rescued"] >= 1, (calls, listener.stats)


def test_no_second_listen_in_a_quiet_room():
    # Quiet room: the quick model is trusted (a second listen only let more sound-alikes through).
    calls: list = []
    listener, events = mishearing_listener(calls)
    feed(listener, say("Hey Bit, play some lofi music."))
    assert commands(events) == [] and "accurate" not in calls, (events, calls)


def test_music_paused_mid_sentence():
    # A loud song under the command; the app pauses it once the name is confirmed
    # (room_changed), and the rest of the sentence is judged against the quiet room.
    rng = np.random.default_rng(3)
    command = say("Hey Bit, what's the weather like today?")
    lead, tail = int(16000 * 1.5), int(16000 * 3)
    voice = np.concatenate([np.zeros(lead, np.int16), command, np.zeros(tail, np.int16)]).astype(np.float32)
    t = np.arange(len(voice)) / 16000
    song = (np.sin(2 * np.pi * 220 * t) + rng.normal(0, 0.6, len(voice))) * (1 + 0.5 * np.sin(2 * np.pi * 2 * t))
    song *= np.sqrt(np.mean(command.astype(np.float32) ** 2)) / np.sqrt(np.mean(song ** 2)) * 0.5  # 6 dB under your voice
    events: list = []
    listener = wake.WakeListener(events.append, lambda a, hint, quality, words: speech.stt.transcribe_pcm(a, quality, hint, words))
    paused_from = None
    for i in range(0, len(voice) - wake.BLOCK + 1, wake.BLOCK):
        music = song[i : i + wake.BLOCK] if paused_from is None or i < paused_from else 0
        listener.feed(np.clip(voice[i : i + wake.BLOCK] + music, -32768, 32767).astype(np.int16))
        if paused_from is None and any(e["phase"] == "listening" for e in events):
            paused_from = i + 3 * wake.BLOCK  # the pause lands a moment later
        if paused_from is not None and i == paused_from:
            listener.room_changed()
    got = commands(events)
    assert paused_from is not None and len(got) == 1 and "weather" in got[0].lower(), events


def test_listening_is_cheap():
    # 20 s of quiet room noise: the always-on part must be far below real time.
    rng = np.random.default_rng(2)
    noise = rng.normal(0, 200, 16000 * 20).astype(np.int16)
    events, listener, cpu = listen(noise)
    assert events == [] and cpu < 20 * 0.1, f"{cpu:.2f}s of CPU for 20s of audio"
    print(f"      (listening costs {cpu / 20 * 100:.1f}% of one core)")


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
