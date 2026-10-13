"""
Tests for beat.py's tempo/phase estimate, on synthetic drum tracks with a
known tempo (no audio device needed).

Run:  venv\\Scripts\\python tests\\test_beat.py
"""

import sys
import traceback
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import beat  # noqa: E402

SR = 48000
rng = np.random.default_rng(7)


def drums(bpm: float, seconds: float = 8.0, start: float = 0.0, swing_noise=0.02, hats=True, music=0.0) -> tuple[np.ndarray, list[float]]:
    """Kick on every beat, snare on 2 and 4, hats on the eighths, optional pad 'music' and noise."""
    n = int(SR * seconds)
    out = np.zeros(n, np.float32)
    t = np.arange(int(SR * 0.25)) / SR
    kick = (np.sin(2 * np.pi * (55 + 90 * np.exp(-t * 30)) * t) * np.exp(-t * 18)).astype(np.float32)
    snare = (rng.normal(0, 1, len(t)) * np.exp(-t * 25)).astype(np.float32) * 0.5
    hat = (rng.normal(0, 1, len(t)) * np.exp(-t * 90)).astype(np.float32) * 0.15
    period = 60 / bpm
    beats = []
    k = 0
    while start + k * period < seconds - 0.3:
        at = start + k * period
        beats.append(at)
        i = int(at * SR)
        out[i : i + len(kick)] += kick[: n - i]
        if k % 2 == 1:
            out[i : i + len(snare)] += snare[: n - i]
        if hats:
            j = int((at + period / 2) * SR)
            if j < n:
                out[j : j + len(hat)] += hat[: n - j]
        k += 1
    if music:
        tt = np.arange(n) / SR
        out += (music * np.sin(2 * np.pi * 220 * tt) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.3 * tt))).astype(np.float32)
    out += rng.normal(0, swing_noise, n).astype(np.float32)
    return out * 0.5, beats


def check(bpm, **kw):
    audio, beats = drums(bpm, **kw)
    est = beat.estimate(audio, SR)
    assert est is not None, f"no beat found at {bpm}"
    # Half/double tempo is a fair answer only if it's how a person might tap it; we want the real one.
    assert abs(est["bpm"] - bpm) <= 2.0, (bpm, est)
    period = 60 / bpm
    next_true = min(b + period * k for b in beats[-1:] for k in range(1, 3) if b + period * k > len(audio) / SR - 1e-3) - len(audio) / SR
    err = min(abs(est["next_beat_s"] - next_true), abs(est["next_beat_s"] - next_true - period), abs(est["next_beat_s"] - next_true + period))
    assert err <= 0.06, f"phase off by {err * 1000:.0f} ms at {bpm} bpm ({est})"
    return est


def test_common_tempos():
    for bpm in (90, 100, 110, 120, 128, 140):
        check(bpm)


def test_with_music_and_noise_on_top():
    check(118, music=0.3, swing_noise=0.05)


def test_beats_not_starting_at_zero():
    check(124, start=0.37)


def test_silence_and_noise_have_no_beat():
    assert beat.estimate(np.zeros(SR * 8, np.float32), SR) is None
    assert beat.estimate(rng.normal(0, 0.1, SR * 8).astype(np.float32), SR) is None


def test_too_short():
    assert beat.estimate(drums(120, seconds=2)[0], SR) is None


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
            traceback.print_exc(limit=2)
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
