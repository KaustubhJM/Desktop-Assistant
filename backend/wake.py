"""
wake.py

"Hey Bit": hands-free voice commands, entirely on this laptop.

When you turn it on (it's off by default), the microphone stays open and
audio flows through here in 0.1-second pieces. Nothing is written to disk
and nothing is sent anywhere; only the last few seconds are kept in memory,
constantly overwritten.

Two stages, so it's both light and hard to fool:
  1. A tiny offline recogniser (Vosk, restricted to "hey/hi/okay <name>")
     listens all the time for about 2% of one CPU core. It's deliberately
     eager: "a bit of bread" or "hey Bill" can trip it.
  2. When it trips, the sentence is transcribed with the same local Whisper
     used for push-to-talk, and only counts if Whisper also heard
     "hey <name>". Whatever you said after the name is the command.
     If the quick model didn't hear the name over music or noise, the
     bigger local model gets a listen before it's dropped.

Feedback comes as early as possible, so it feels instant:
  - the moment the tripwire fires (~0.3 s after the name) the robot perks up
    (no sound: it may be a false alarm);
  - Whisper then checks just the first moment of audio, and once it's sure,
    the robot shows its listening face while you're still talking (no chime:
    it would land on your words) and the app pauses any music;
  - the whole sentence is transcribed when you stop.
If you say just "Hey Bit" and pause, it chimes and waits a few seconds for the command.

Events (to the desktop app, through on_event):
  {"type": "wake", "phase": "attention"}            tripwire: maybe its name (perk up, quietly)
  {"type": "wake", "phase": "listening", "speaking": bool}
                                                    sure it was its name (listening face; chime
                                                    unless you're still talking)
  {"type": "wake", "phase": "command", "text": ...} the command to run
  {"type": "wake", "phase": "cancel"}               nothing followed the name

Each attempt leaves one line in the backend log (what happened and why, never
what was said), so a miss can be told apart from a mishearing.
"""

import json
import queue
import re
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable, Optional

import numpy as np

MODEL_DIR = Path(__file__).parent / "models" / "vosk-model-small-en-us-0.15"
RATE = 16000
BLOCK = 1600  # 0.1 s
RING_BLOCKS = 40  # keep the last 4 s, so the name itself is in what Whisper hears
LOOKBACK_BLOCKS = 25  # start the sentence 2.5 s before the tripwire fired
MAX_UTTERANCE_BLOCKS = 150  # 15 s, counting the lookback before the name
FOLLOWUP_WAIT_BLOCKS = 60  # after a bare "Hey Bit", wait 6 s for the command to start
END_QUIET_BLOCKS = 10  # the sentence is over after 1 s of quiet (0.8 s cut off "remind me to… call mom"; more feels slow)
EARLY_CHECK_BLOCKS = 3  # confirm the name 0.3 s after the tripwire, without waiting for the sentence to end
# Speech is anything clearly above the room's background. Laptop mic arrays
# with noise suppression output near-silence between words, so the floor can
# be ~0 and a fixed high bar would cut off anyone not leaning in.
MIN_SPEECH_RMS = 20
SPEECH_OVER_FLOOR = 3.0
# Background above this (about -45 dBFS) is music or noise, not a quiet room:
# then the bigger model gets a second listen when the quick one misses the name.
LOUD_ROOM_RMS = 180
GREETINGS = ("hey", "hi", "okay")


def _clean_names(names: list[str]) -> list[str]:
    out = []
    for n in names:
        n = n.strip().lower()
        if re.fullmatch(r"[a-z]{2,20}", n) and n not in out:
            out.append(n)
    return out or ["bit"]


class WakeListener:
    def __init__(self, on_event: Callable[..., dict], transcribe: Callable[..., dict], names: Optional[list[str]] = None):
        self.on_event = on_event
        # (float32 16 kHz mono, spelling hint, quality, words: bool) -> {"text", "words": [{"word", "start"}]}
        self.transcribe = transcribe
        # "fast" | "accurate" | "online". Checking that the name was said is
        # always done locally; with "online", only the command after it is sent.
        self.quality = "fast"
        self.enabled = False
        self.muted = False
        self.error: Optional[str] = None
        self.stats = {"candidates": 0, "confirmed": 0, "rejected": 0, "rescued": 0}
        self._model = None
        self._rec = None
        self._stream = None
        self._queue: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=100)
        self._worker: Optional[threading.Thread] = None
        self._lock = threading.RLock()
        self._heard = 0  # blocks from the microphone so far (the worker may be behind, busy transcribing)
        self._fed = 0  # blocks processed so far
        self._room_change_at: Optional[int] = None
        self.set_names(names or ["bit"])
        self._reset()

    # ------------------------------------------------------------ settings

    def set_names(self, names: list[str]) -> None:
        with self._lock:
            # "bit" always works, so renaming the robot to a word the
            # recogniser doesn't know never breaks hands-free mode.
            self.names = _clean_names(list(names) + ["bit"])
            alt = "|".join(self.names)
            # Whisper mishears a short, unusual name ("Hey, bet", "Hey, Bitts")
            # without context; this hint fixes that without making it imagine
            # the name in "hey, but…" or "a bit of…".
            caps = [n.capitalize() for n in self.names]
            also = f", also called {', '.join(caps[1:])}" if len(caps) > 1 else ""
            self.hint = f"{caps[0]} is a little robot{also}. " + " ".join(f"Hey {c}!" for c in caps)
            self._trip = re.compile(rf"\b({'|'.join(GREETINGS)}) ({alt})\b")
            self._confirm = re.compile(rf"\b(hey|hi|hiya|okay|ok)\W+({alt})\b\W*", re.I)
            self._rec = None  # rebuilt with the new grammar on next use

    def _recognizer(self):
        if self._rec is None:
            from vosk import KaldiRecognizer, Model, SetLogLevel

            SetLogLevel(-1)
            if self._model is None:
                self._model = Model(str(MODEL_DIR))
            grammar = [f"{g} {n}" for n in self.names for g in GREETINGS] + ["[unk]"]
            self._rec = KaldiRecognizer(self._model, RATE, json.dumps(grammar))
        return self._rec

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "listening": self.enabled and self._stream is not None and not self.muted,
            "muted": self.muted,
            "error": self.error,
            "names": self.names,
            "quality": self.quality,
            "model": MODEL_DIR.exists(),
            **self.stats,
        }

    # ------------------------------------------------------------ microphone

    def start(self) -> dict:
        """Open the microphone and start listening. Safe to call twice."""
        with self._lock:
            if self.enabled and self._stream is not None:
                return self.status()
            self.enabled, self.error = True, None
            if not MODEL_DIR.exists():
                self.error = "The wake-word model isn't downloaded — run download_models.py."
                return self.status()
            try:
                self._recognizer()
                import sounddevice as sd

                self._stream = sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=BLOCK, callback=self._on_audio)
                self._stream.start()
            except Exception as err:  # no microphone, blocked in Windows privacy settings, ...
                self._stream = None
                self.error = f"I can't open the microphone ({type(err).__name__}). Check Windows Settings → Privacy → Microphone."
                print(f"[wake] {self.error}: {err}")
                return self.status()
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._work, daemon=True, name="wake-word")
                self._worker.start()
            print("[wake] listening for", ", ".join(f"'hey {n}'" for n in self.names))
            return self.status()

    def stop(self) -> dict:
        """Close the microphone (the Windows mic indicator goes away)."""
        with self._lock:
            self.enabled = False
            stream, self._stream = self._stream, None
            self._reset()
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
            print("[wake] stopped listening")
        return self.status()

    def set_muted(self, muted: bool) -> None:
        """Muted while the robot talks (so it can't wake itself) or push-to-talk records."""
        with self._lock:
            if muted and not self.muted:
                self._reset()
            self.muted = muted

    def _on_audio(self, indata, frames, time_info, status) -> None:  # audio thread: keep it tiny
        self._heard += 1
        try:
            self._queue.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass

    @property
    def capturing(self) -> bool:
        """In the middle of hearing a "Hey Bit" sentence (or waiting for the command after one)."""
        return self._state != "waiting"

    def room_changed(self) -> None:
        """The music was just paused so it can hear you: from the audio heard after
        this moment, measure the room afresh, so the end of your sentence is judged
        against the quiet room, not the song (and the song's loud moments before the
        pause don't count as the pause that ends your sentence)."""
        at = max(self._heard, self._fed)
        with self._lock:
            if self._state != "waiting":
                self._room_change_at = at

    def _work(self) -> None:
        while True:
            block = self._queue.get()
            if not self.enabled:
                continue
            try:
                self.feed(block)
            except Exception as err:
                print(f"[wake] error: {err}")
                self._reset()

    # ------------------------------------------------------------ detection

    def _reset(self) -> None:
        self._state = "waiting"  # waiting | capturing | followup
        self._ring: deque = deque(maxlen=RING_BLOCKS)
        self._capture: list[np.ndarray] = []
        self._levels: deque = deque(maxlen=RING_BLOCKS)
        self._spoke = False  # heard speech since the capture started
        self._quiet = 0  # quiet blocks in a row
        self._checked = False  # tried the early confirmation for this capture
        self._waited = 0  # blocks spent waiting for the command after a bare "Hey Bit"
        self._name_at: Optional[float] = None  # seconds into the capture where "hey <name>" starts, once confirmed
        self._room_change_at = None
        self._new_room = False  # the music just paused: no background level measured yet
        self._tripped_at = 0.0  # when the tripwire fired (for the log)
        self._rescued = False  # the bigger model heard the name the quick one missed (for the log)
        self._announced_speaking = False  # "listening" went out without a chime (you were still talking)
        self._asked_bigger = False  # the bigger model had a listen too (for the log)
        if self._rec is not None:
            self._rec.Reset()

    def feed(self, block: np.ndarray) -> None:
        """Process 0.1 s of 16 kHz int16 audio (from the mic, or a test)."""
        with self._lock:
            if self.muted:
                return
            self._fed += 1
            if self._room_change_at is not None and self._fed > self._room_change_at:
                # The music stopped here: judge the rest against the quiet room.
                self._room_change_at = None
                self._levels.clear()
                self._new_room = True
                self._quiet = 0
            self._ring.append(block)
            rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
            self._levels.append(rms)

            if self._state == "waiting":
                rec = self._recognizer()
                ended = rec.AcceptWaveform(block.tobytes())
                heard = json.loads(rec.Result() if ended else rec.PartialResult())
                if self._trip.search(heard.get("text", heard.get("partial", ""))):
                    self.stats["candidates"] += 1
                    self._state = "capturing"
                    self._capture = list(self._ring)[-LOOKBACK_BLOCKS:]
                    self._spoke, self._quiet = True, 0
                    self._trip_len = len(self._capture)
                    self._tripped_at = time.perf_counter()
                    self._emit({"phase": "attention"})
                return

            # Capturing a sentence: it ends after a pause, measured against
            # this room's own background level (fans, music...).
            self._capture.append(block)
            if rms > self._speech_threshold():
                self._spoke, self._quiet = True, 0
            else:
                self._quiet += 1
            if self._state == "capturing":
                if not self._checked and len(self._capture) - self._trip_len >= EARLY_CHECK_BLOCKS:
                    self._early_check()
                over = self._spoke and self._quiet >= END_QUIET_BLOCKS
                if over or len(self._capture) >= MAX_UTTERANCE_BLOCKS:
                    self._finish_capture("a pause" if over else "the 15 s limit")
            else:
                self._waited += 1
                over = self._spoke and self._quiet >= END_QUIET_BLOCKS
                if over or len(self._capture) >= MAX_UTTERANCE_BLOCKS:
                    self._finish_followup()
                elif not self._spoke and self._waited >= FOLLOWUP_WAIT_BLOCKS:
                    self._log("cancelled: nothing after the name")
                    self._emit({"phase": "cancel"})
                    self._reset()

    def _speech_threshold(self) -> float:
        # Just after the music paused there's no background level yet: anything
        # above near-silence counts as you talking until there is (0.8 s).
        if self._new_room and len(self._levels) < 8:
            return MIN_SPEECH_RMS
        self._new_room = False
        floor = float(np.percentile(self._levels, 20)) if self._levels else 0.0
        return max(MIN_SPEECH_RMS, floor * SPEECH_OVER_FLOOR)

    def _loud_room(self) -> bool:
        """Music or noise in the background (not just you talking in a quiet room)."""
        return len(self._levels) >= 8 and float(np.percentile(self._levels, 20)) > LOUD_ROOM_RMS

    def _audio(self, start: int = 0) -> np.ndarray:
        return np.concatenate(self._capture[start:]).astype(np.float32) / 32768

    def _check_name(self, audio: np.ndarray, quality: str, words: bool) -> tuple[dict, Optional[re.Match]]:
        """Did Whisper hear "hey <name>"? If the quick model didn't (music, a noisy
        room), the bigger one gets a listen before it's dropped. Both run on this
        laptop: nothing is sent anywhere until the name is confirmed."""
        heard = self.transcribe(audio, self.hint, quality, words)
        match = self._confirm.search(heard["text"])
        # Only over music or noise: in a quiet room the quick model hears the name
        # fine, and a second listen there only let more "Hey Bittu"s and "Hey beta"s
        # through (+4 of 66 sound-alikes) at twice the CPU per false alarm.
        if match or quality == "accurate" or not self._loud_room():
            return heard, match
        self._asked_bigger = True
        heard = self.transcribe(audio, self.hint, "accurate", words)
        match = self._confirm.search(heard["text"])
        if match:
            self._rescued = True
            self.stats["rescued"] += 1
        return heard, match

    def _early_check(self) -> None:
        """Is it really its name? Decided from the first moment of audio, while you're still talking."""
        self._checked = True
        heard, match = self._check_name(self._audio(), "fast", True)
        if match:
            self._name_at = self._name_starts_at(heard.get("words") or []) or 0.0
            self.stats["confirmed"] += 1
            # Still talking (speech since the tripwire): the robot shows it's listening
            # without a chime on top of your words. Just "Hey Bit" and quiet: chime.
            self._announced_speaking = self._quiet < EARLY_CHECK_BLOCKS
            self._emit({"phase": "listening", "speaking": self._announced_speaking})
        # Not sure yet (e.g. cut off mid-word): decided again when the sentence ends.

    def _finish_capture(self, ended: str = "a pause") -> None:
        local = "accurate" if self.quality == "accurate" else "fast"
        if self._name_at is not None:
            # Already confirmed (and the robot is showing it): just the sentence from the name on.
            start = self._name_at
            audio = self._audio()[max(0, int((start - 0.25) * RATE)):]
            quality = local if self.quality != "online" else "online"
            text = self.transcribe(audio, self.hint, quality, False)["text"]
            match = self._confirm.search(text)
            command = (text[match.end():] if match else text).strip(" ,.!?-—")
            self._command_or_wait(command, announced=True, how=f"name heard early{self._by()}, ended by {ended}")
            return
        audio = self._audio()
        heard, match = self._check_name(audio, local, self.quality == "online")
        text = heard["text"]
        if not match:
            self.stats["rejected"] += 1
            self._log(f"tripwire, but Whisper didn't hear its name{' (nor did the bigger model)' if self._asked_bigger else ''}, ended by {ended}")
            self._reset()  # e.g. "a bit of bread": not for us
            return
        self.stats["confirmed"] += 1
        command = text[match.end():].strip(" ,.!?-—")
        start = self._name_starts_at(heard.get("words") or [])
        if self.quality == "online" and start is not None and re.search(r"[a-zA-Z]{2,}", command):
            # Better with names. Only the audio from "Hey Bit" on is sent, so
            # whatever you were saying to someone else beforehand stays here.
            refined = self.transcribe(audio[max(0, int((start - 0.25) * RATE)):], self.hint, "online", False)["text"]
            m = self._confirm.search(refined)
            refined = (refined[m.end():] if m else refined).strip(" ,.!?-—")
            command = refined or command
        self._command_or_wait(command, announced=False, how=f"name heard at the end{self._by()}, ended by {ended}")

    def _command_or_wait(self, command: str, announced: bool, how: str = "") -> None:
        """Run the command, or (just "Hey Bit") wait a few seconds for one."""
        if re.search(r"[a-zA-Z]{2,}", command):
            self._log(f"command ({how})")
            self._emit({"phase": "command", "text": command})
            self._reset()
        else:
            self._log(f"just the name, waiting for the command ({how})")
            if not announced or self._announced_speaking:
                # Your turn: the chime (it was held back while it seemed you were still talking).
                self._emit({"phase": "listening", "speaking": False})
            tripped_at = self._tripped_at
            self._reset()
            self._state = "followup"
            self._spoke = False
            self._tripped_at = tripped_at

    def _by(self) -> str:
        return " by the bigger model" if self._rescued else ""

    def _log(self, outcome: str) -> None:
        """One line per attempt in the backend log: what happened and why, never what was said."""
        took = time.perf_counter() - self._tripped_at if self._tripped_at else 0.0
        seconds = sum(len(b) for b in self._capture) / RATE
        room = float(np.percentile(self._levels, 20)) if self._levels else 0.0
        room_db = 20 * np.log10(max(room, 1.0) / 32768)
        print(f"[wake] {outcome}; {seconds:.1f} s of audio, {took:.1f} s since the tripwire, room {room_db:.0f} dBFS")

    def _name_starts_at(self, words: list[dict]) -> Optional[float]:
        """When "hey <name>" starts in the audio (seconds), from Whisper's word timings."""
        for i, w in enumerate(words):
            pair = w["word"].strip() + (" " + words[i + 1]["word"].strip() if i + 1 < len(words) else "")
            if self._confirm.match(pair) or self._confirm.match(w["word"].strip()):  # "Hey Bit" or "Hi-bit"
                return float(w["start"])
        return None

    def _finish_followup(self) -> None:
        local = "accurate" if self.quality == "accurate" else "fast"
        text = self.transcribe(self._audio(), self.hint, local, False)["text"].strip()
        if not re.search(r"[a-zA-Z]{2,}", text):
            # A sound without words (its own chime, a cough, a door): keep waiting
            # for the command until the time is up. Nothing was sent anywhere.
            if self._waited < FOLLOWUP_WAIT_BLOCKS:
                self._capture, self._spoke, self._quiet = [], False, 0
                return
            self._log("cancelled: only sounds after the name")
            self._emit({"phase": "cancel"})
            self._reset()
            return
        if self.quality == "online":
            text = self.transcribe(self._audio(), self.hint, "online", False)["text"].strip() or text
        # They may repeat the name: "Hey Bit … hey Bit, what time is it?"
        match = self._confirm.match(text)
        if match:
            text = text[match.end():].strip()
        text = text.strip(" ,.!?-—")
        ok = re.search(r"[a-zA-Z]{2,}", text)
        self._log("command (after a pause following the name)" if ok else "cancelled: nothing after the name")
        self._emit({"phase": "command", "text": text} if ok else {"phase": "cancel"})
        self._reset()

    def _emit(self, event: dict) -> None:
        try:
            self.on_event({"type": "wake", "text": "", **event})
        except Exception as err:
            print(f"[wake] couldn't deliver event: {err}")
