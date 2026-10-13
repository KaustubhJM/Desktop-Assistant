"""
beat.py

Dancing to the actual beat: while a song plays (activity.py says so), a small
helper process listens to what the laptop is playing (the speakers'
"loopback", never the microphone), works out the tempo and where the beats
fall, and the robot bobs in time. The audio is analysed in memory a few
seconds at a time and thrown away: never saved, never sent anywhere.

It runs as its own process (`python beat.py`, started and stopped by
BeatListener) because audio-device code in the same process as the speech
engines is a crash risk (see media_helper.py). It prints one JSON line every
two seconds: {"bpm": 121.5, "next_beat_ms": 210, "confidence": 0.62}, or
{"bpm": 0} when it can't hear a steady beat.

estimate() is the maths (tested on synthetic drum tracks in tests/test_beat.py).
"""

import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np

HOP = 512  # samples between onset frames
FRAME = 1024
WINDOW_S = 8.0  # seconds of audio per estimate
MIN_BPM, MAX_BPM = 70, 180
SILENCE_RMS = 0.004
MIN_CONFIDENCE = 0.18


def onset_envelope(mono: np.ndarray, sr: int, band: tuple[float, float] = (0, 20000)) -> np.ndarray:
    """How sharply the sound rises at each frame (spectral flux) within a frequency band."""
    n = 1 + (len(mono) - FRAME) // HOP
    if n < 8:
        return np.zeros(0)
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n)[:, None]
    frames = mono[idx] * np.hanning(FRAME)
    mag = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(FRAME, 1 / sr)
    sel = (freqs >= band[0]) & (freqs < band[1])
    logmag = np.log1p(100 * mag[:, sel])
    flux = np.maximum(0, np.diff(logmag, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")  # remove slow loudness changes
    return np.maximum(0, flux)


def _strength(env: np.ndarray) -> float:
    """How "peaky" an onset envelope is (a steady kick drum vs a smear)."""
    return float(np.percentile(env, 99) / (np.mean(env) + 1e-9)) if len(env) else 0.0


def estimate(mono: np.ndarray, sr: int) -> Optional[dict]:
    """-> {"bpm", "next_beat_s" (from the end of the audio), "confidence"} or None (no steady beat / silence)."""
    if len(mono) < sr * 3 or float(np.sqrt(np.mean(mono ** 2))) < SILENCE_RMS:
        return None
    # The beat lives in the kick drum and bass: use the low band when it has
    # clear hits (hi-hats on every half-beat would otherwise double the tempo).
    low = onset_envelope(mono, sr, (20, 150))
    full = onset_envelope(mono, sr)
    env = low if _strength(low) >= 6 else full
    if len(env) < 64 or env.max() <= 0:
        return None
    env = env / (env.std() + 1e-9)
    fps = sr / HOP
    ac = np.correlate(env - env.mean(), env - env.mean(), mode="full")[len(env) - 1:]
    ac /= ac[0] + 1e-9
    lags = np.arange(len(ac))
    lo, hi = int(fps * 60 / MAX_BPM), int(fps * 60 / MIN_BPM) + 1
    if hi >= len(ac):
        return None
    bpms = 60 * fps / np.maximum(lags[lo:hi], 1)
    prior = np.exp(-0.5 * (np.log2(bpms / 110) / 0.7) ** 2)  # most music sits around 110 bpm
    score = ac[lo:hi] * prior
    best = int(np.argmax(score)) + lo
    # Refine to a fractional lag (parabola through the peak).
    if lo < best < hi - 1:
        a, b, c = ac[best - 1], ac[best], ac[best + 1]
        shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0
        period = best + float(np.clip(shift, -0.5, 0.5))
    else:
        period = float(best)
    confidence = float(ac[best])
    if confidence < MIN_CONFIDENCE:
        return None
    # Phase: the offset whose comb of beats lines up with the most onsets.
    p = int(round(period))
    combs = [env[o::p].sum() / max(1, len(env[o::p])) for o in range(p)]
    offset = int(np.argmax(combs))
    last = offset + p * ((len(env) - 1 - offset) // p)
    next_beat_frames = last + period - (len(env) - 1)
    return {"bpm": round(60 * fps / period, 1), "next_beat_s": max(0.0, next_beat_frames / fps), "confidence": round(confidence, 2)}


# ------------------------------------------------------------------ the helper process

def _listen_forever() -> None:
    import pyaudiowpatch as pyaudio

    p = pyaudio.PyAudio()
    wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    speaker = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
    loop = next((d for d in p.get_loopback_device_info_generator() if speaker["name"] in d["name"]), None)
    if loop is None:
        print(json.dumps({"bpm": 0, "error": "no loopback device"}), flush=True)
        return
    sr, ch = int(loop["defaultSampleRate"]), int(loop["maxInputChannels"])
    stream = p.open(format=pyaudio.paInt16, channels=ch, rate=sr, input=True, input_device_index=loop["index"], frames_per_buffer=HOP * 2)
    keep = int(sr * WINDOW_S)
    buf = np.zeros(0, np.float32)
    last_report = 0.0
    while True:
        data = np.frombuffer(stream.read(HOP * 2, exception_on_overflow=False), np.int16).astype(np.float32) / 32768
        mono = data.reshape(-1, ch).mean(axis=1) if ch > 1 else data
        buf = np.concatenate([buf, mono])[-keep:]
        now = time.monotonic()
        if now - last_report >= 2.0 and len(buf) >= sr * 4:
            last_report = now
            est = estimate(buf, sr)
            out = {"bpm": 0} if est is None else {"bpm": est["bpm"], "next_beat_ms": int(est["next_beat_s"] * 1000), "confidence": est["confidence"]}
            print(json.dumps(out), flush=True)


class BeatListener:
    """Starts/stops `python beat.py` and passes its beats on (on_beat)."""

    def __init__(self, on_beat: Callable[[dict], None]):
        self.on_beat = on_beat
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> None:
        with self._lock:
            if self.running:
                return
            self._proc = subprocess.Popen(
                [sys.executable, str(Path(__file__)), "--listen"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.PIPE, text=True,
                cwd=str(Path(__file__).parent), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            proc = self._proc
            threading.Thread(target=self._read, args=(proc,), daemon=True).start()
            print("[beat] listening for the beat")

    def _read(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            try:
                self.on_beat(json.loads(line))
            except (json.JSONDecodeError, Exception):
                pass

    def stop(self) -> None:
        with self._lock:
            if self._proc is not None:
                try:
                    self._proc.kill()
                except OSError:
                    pass
                self._proc = None
                self.on_beat({"bpm": 0})
                print("[beat] stopped")


if __name__ == "__main__" and "--listen" in sys.argv:
    # Exit with the backend: it holds our stdin open.
    threading.Thread(target=lambda: (sys.stdin.read(), __import__("os")._exit(0)), daemon=True).start()
    _listen_forever()
