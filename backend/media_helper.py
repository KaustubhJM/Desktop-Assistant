"""
media_helper.py

A tiny separate process that does all the talking to Windows' media sessions
(winrt) for the backend: "pause", "what's playing?", and the activity
watcher's "is a song playing?".

Why a separate process: winrt calls running alongside the speech engines'
native code (onnxruntime for the voice, CTranslate2 for Whisper) crash the
whole process with an access violation, reproducibly within seconds. Here,
if anything goes wrong, only this helper dies; media.py starts a new one.

Protocol: one JSON object per line on stdin, one reply per line on stdout.
  {"id": 1, "cmd": "control", "command": "pause"} -> {"id": 1, "ok": true, "text": "Paused."}
  {"id": 2, "cmd": "sessions"}                     -> {"id": 2, "sessions": [{app, playing, title, artist}]}
  {"id": 3, "cmd": "hold"} / "release" / "forget"  -> pause what's playing while Bit listens, resume it after
                                                      ({"paused": bool} / {"resumed": bool} / {})
It exits when the backend closes its stdin (or dies).
"""

import asyncio
import json
import sys

import media

media.ISOLATE = False  # this *is* the isolated side


async def handle(msg: dict) -> dict:
    if msg.get("cmd") == "control":
        ok, text = await media.control(msg.get("command"))
        return {"ok": ok, "text": text}
    if msg.get("cmd") == "sessions":
        return {"sessions": await media.sessions()}
    if msg.get("cmd") == "hold":
        return {"paused": await media.hold()}
    if msg.get("cmd") == "release":
        return {"resumed": await media.release()}
    if msg.get("cmd") == "forget":
        await media.forget()
        return {}
    return {"error": "unknown command"}


def main() -> None:
    loop = asyncio.new_event_loop()
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            reply = loop.run_until_complete(handle(msg))
        except Exception as err:
            reply = {"error": type(err).__name__}
        sys.stdout.write(json.dumps({"id": msg.get("id"), **reply}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
