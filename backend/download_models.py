"""
download_models.py — fetch the local speech models (run once).

  venv\\Scripts\\python download_models.py

Kokoro (voice, ~340 MB) comes from the kokoro-onnx GitHub release; the
"Hey Bit" wake-word model (Vosk small English, ~40 MB) from alphacephei.com. Whisper
(speech recognition) downloads itself from Hugging Face on first use, but this
script fetches the default model now so the first voice command is quick.
"""

import urllib.request
import zipfile
from pathlib import Path

MODELS = Path(__file__).parent / "models"
KOKORO = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
VOSK = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"  # "Hey Bit" wake word, ~40 MB


def fetch(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"already have {dest.name}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {dest.name} ...")
    tmp = dest.with_suffix(dest.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(dest)
    print(f"  {dest.stat().st_size // (1024 * 1024)} MB")


if __name__ == "__main__":
    for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        fetch(KOKORO + name, MODELS / "kokoro" / name)
    if not (MODELS / "vosk-model-small-en-us-0.15").exists():
        archive = MODELS / "vosk-small.zip"
        fetch(VOSK, archive)
        with zipfile.ZipFile(archive) as z:
            z.extractall(MODELS)
        archive.unlink()
    else:
        print("already have the wake-word model")
    from faster_whisper import WhisperModel

    print("fetching Whisper base.en ...")
    WhisperModel("base.en", device="cpu", compute_type="int8", download_root=str(MODELS / "whisper"))
    print("done")
