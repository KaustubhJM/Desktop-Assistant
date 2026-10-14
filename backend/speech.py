"""
speech.py

Local speech, behind two tiny interfaces so engines can be swapped later
(e.g. a cloud voice) without touching the rest of the backend:

  SpeechToText.transcribe(wav_bytes) -> text      faster-whisper (local)
  TextToSpeech.synthesize(text)      -> wav_bytes  Kokoro (local)

Models load on first use and unload after IDLE_UNLOAD_S of no use, so the
backend stays light when you're not talking to the robot. Everything runs on
the CPU; nothing leaves the laptop.

The one exception is speech recognition quality "online", which you have to
choose in Settings: the command you spoke (only that) is sent to Groq's
Whisper large-v3-turbo, which is much better with names (Indian artists,
YouTubers, Hindi/Punjabi titles). If it fails, the local model is used.
"""

import io
import os
import threading
import time
import wave
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
from dotenv import load_dotenv

load_dotenv()

MODELS = Path(__file__).parent / "models"
IDLE_UNLOAD_S = 600

STT_MODELS = {"fast": "base.en", "accurate": "small.en"}
GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")
# Primes Whisper to write Indian names in their usual romanised spelling.
NAMES_HINT = "Play Arijit Singh, CarryMinati, Sidhu Moose Wala, BB Ki Vines, Sajde, Tu Maan Meri Jaan on YouTube."
VOICES = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova", "bf_emma"]


class _Lazy:
    """Load on first use, unload after a quiet period."""

    def __init__(self):
        self._lock = threading.Lock()
        self._last_used = 0.0
        self.keep_warm = False  # set while hands-free "Hey Bit" is on: never unload
        threading.Thread(target=self._reaper, daemon=True).start()

    def _reaper(self):
        while True:
            time.sleep(30)
            with self._lock:
                if self._loaded() and not self.keep_warm and time.time() - self._last_used > IDLE_UNLOAD_S:
                    self._unload()

    def _touch(self):
        self._last_used = time.time()

    def _loaded(self) -> bool:  # pragma: no cover - overridden
        raise NotImplementedError

    def _unload(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError


class SpeechToText(_Lazy):
    def __init__(self):
        self._model = None
        self._model_name: Optional[str] = None
        super().__init__()

    def _loaded(self) -> bool:
        return self._model is not None

    def _unload(self) -> None:
        self._model = None
        self._model_name = None

    def transcribe(self, wav_bytes: bytes, quality: str = "fast") -> dict:
        return self.transcribe_pcm(_read_wav_16k_mono(wav_bytes), quality)

    def transcribe_pcm(self, audio: np.ndarray, quality: str = "fast", hint: Optional[str] = None, words: bool = False) -> dict:
        """float32 mono 16 kHz in memory (push-to-talk WAVs, the wake word) -> text
        (and, with words=True and a local model, when each word starts)."""
        if quality == "online":
            try:
                return _transcribe_online(audio, hint)
            except Exception as err:  # offline, no key, rate limit: fall back to the local model
                print(f"[speech] online recognition failed ({type(err).__name__}); using the local model")
                result = self.transcribe_pcm(audio, "fast", hint)
                return {**result, "fallback": True}
        name = STT_MODELS.get(quality, STT_MODELS["fast"])
        with self._lock:
            self._touch()
            t0 = time.perf_counter()
            if self._model_name != name:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(name, device="cpu", compute_type="int8", download_root=str(MODELS / "whisper"))
                self._model_name = name
            load_s = time.perf_counter() - t0
            t1 = time.perf_counter()
            segments, _ = self._model.transcribe(
                _normalize(audio), language="en", beam_size=1, vad_filter=True, initial_prompt=hint, word_timestamps=words
            )
            segments = list(segments)
            text = " ".join(s.text.strip() for s in segments).strip()
            timed = [{"word": w.word, "start": w.start, "prob": round(float(w.probability), 3)} for s in segments for w in (s.words or [])]
            # How sure Whisper is (its own average log-probability; the least sure part counts).
            logprob = min((float(s.avg_logprob) for s in segments), default=None)
            self._touch()
        return {"text": text, "words": timed, "logprob": logprob, "seconds": round(time.perf_counter() - t1, 2), "load_seconds": round(load_s, 2), "model": name}


class TextToSpeech(_Lazy):
    def __init__(self):
        self._kokoro = None
        super().__init__()

    def _loaded(self) -> bool:
        return self._kokoro is not None

    def _unload(self) -> None:
        self._kokoro = None

    def synthesize(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> bytes:
        if voice not in VOICES:
            voice = VOICES[0]
        with self._lock:
            self._touch()
            if self._kokoro is None:
                from kokoro_onnx import Kokoro

                self._kokoro = Kokoro(str(MODELS / "kokoro" / "kokoro-v1.0.onnx"), str(MODELS / "kokoro" / "voices-v1.0.bin"))
            lang = "en-gb" if voice.startswith("b") else "en-us"
            samples, sr = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
            self._touch()
        return _to_wav(samples, sr)


def available() -> dict:
    """Which local engines can run (model files present / downloadable)."""
    kokoro_ok = (MODELS / "kokoro" / "kokoro-v1.0.onnx").exists() and (MODELS / "kokoro" / "voices-v1.0.bin").exists()
    try:
        import faster_whisper  # noqa: F401

        whisper_ok = True
    except ImportError:
        whisper_ok = False
    return {"tts": kokoro_ok, "stt": whisper_ok, "voices": VOICES}


# ------------------------------------------------------------------- audio io

def _transcribe_online(audio: np.ndarray, hint: Optional[str]) -> dict:
    key = os.getenv("GROQ_API_KEY", "")
    if not key:
        raise RuntimeError("no GROQ_API_KEY")
    t0 = time.perf_counter()
    with httpx.Client(timeout=12) as client:
        resp = client.post(
            GROQ_STT_URL,
            headers={"Authorization": f"Bearer {key}"},
            files={"file": ("speech.wav", _to_wav(_normalize(audio), 16000), "audio/wav")},
            data={"model": GROQ_STT_MODEL, "language": "en", "response_format": "verbose_json", "temperature": "0",
                  "prompt": " ".join(p for p in (hint, NAMES_HINT) if p)},
        )
        resp.raise_for_status()
    data = resp.json()
    text = str(data.get("text") or "").strip()
    logprob = min((float(s["avg_logprob"]) for s in data.get("segments") or [] if "avg_logprob" in s), default=None)
    return {"text": text, "logprob": logprob, "seconds": round(time.perf_counter() - t0, 2), "load_seconds": 0, "model": GROQ_STT_MODEL}


def _normalize(audio: np.ndarray, peak: float = 0.7, max_gain: float = 20.0) -> np.ndarray:
    """Bring quiet speech (you, across the desk) up to a normal level for Whisper."""
    top = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if top <= 1e-4:
        return audio
    return (audio * min(max_gain, peak / top)).astype(np.float32) if top < peak else audio


def _to_wav(samples: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _read_wav_16k_mono(data: bytes) -> np.ndarray:
    """Decode a 16-bit PCM WAV into float32 mono at 16 kHz (what Whisper wants)."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError("expected 16-bit PCM WAV")
            channels, rate = w.getnchannels(), w.getframerate()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    except (wave.Error, EOFError) as err:
        raise ValueError(f"not a valid WAV file ({err})") from None
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and len(pcm):
        x = np.linspace(0, len(pcm) - 1, int(len(pcm) * 16000 / rate))
        pcm = np.interp(x, np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


stt = SpeechToText()
tts = TextToSpeech()
