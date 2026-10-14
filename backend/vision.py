"""
vision.py

"Help me with this", "what does this error mean?", "look at my screen":
the app takes a screenshot of the screen you're on (Bit and its chat window
left out), and a model that can see (agent.call_vision: Gemini Flash, or Qwen
on Groq, with the keys you already have) works out what you mean and helps.

This is the one place your screen leaves the laptop, and only when you ask:
the screenshot goes to that model and is never saved; the chat panel says
where it went. Then Bit keeps looking while you talk about it: each follow-up
("why is it doing that?", "and line 3?") comes with a fresh screenshot, and
the normal conversation model answers it with eyes (conversation.converse
with an image), until you say "stop looking" or go quiet for a few minutes.
"""

import base64
import re
from datetime import datetime
from typing import Optional

import agent

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MIMES = {"image/jpeg", "image/png"}

PROMPT = """You are {name}, a friendly desktop robot helping the user with what's on their screen. Now: {now}.
The attached screenshot is their screen right now. They asked: "{question}"
{history}
Work out what they most likely mean: the window in front, an error message, highlighted or selected text,
code with a problem, a question or form on the screen. Then actually help: explain it, answer it, or say how
to fix it (with the corrected code if it's code). If they only asked you to look ("look at my screen", "can you
see this?") or it isn't clear what they need, say in one short sentence what you see and ask what they'd like
help with (end with a question). They'll keep asking about it, so be specific: names, line numbers, the exact error.

Reply in exactly this format, nothing else:
SAY: <1 or 2 short, natural spoken sentences, under 40 words; no markdown, no code, no links>
DETAILS: <markdown for the chat panel: the explanation, steps or fixed code (code blocks welcome), or the single word none>
SEEN: <one short sentence: what on the screen this was about, e.g. "a Python KeyError in VS Code, line 42">"""

# How the panel says where the screenshot went.
PROVIDERS = {"gemini": "Google Gemini", "groq": "Groq"}


def parse(text: str) -> tuple[str, Optional[str], str]:
    """'SAY: …\\nDETAILS: …\\nSEEN: …' -> (say, details, seen). Tolerates a missing format."""
    text = (text or "").strip()
    seen = ""
    m = re.search(r"\n\s*SEEN:\s*(.+?)\s*$", text, re.S | re.I)
    if m:
        seen = " ".join(m.group(1).split())[:200]
        text = text[: m.start()].rstrip()
    m = re.search(r"SAY:\s*(.+?)(?:\n\s*DETAILS:\s*(.*))?$", text, re.S | re.I)
    if m:
        say = " ".join(m.group(1).split())
        details = (m.group(2) or "").strip()
        return say, (None if details.lower().rstrip(".") in ("", "none") else details), seen
    sentences = re.split(r"(?<=[.!?])\s+", " ".join(text.split()))
    return " ".join(sentences[:2]), (text if len(sentences) > 2 else None), seen


def decode(image_b64: str, mime: str) -> Optional[bytes]:
    """The screenshot's bytes if it's a sane JPEG/PNG, else None."""
    if mime not in MIMES:
        return None
    try:
        data = base64.b64decode(image_b64, validate=True)
    except (ValueError, TypeError):
        return None
    if not data or len(data) > MAX_IMAGE_BYTES:
        return None
    magic_ok = data.startswith(b"\xff\xd8\xff") if mime == "image/jpeg" else data.startswith(b"\x89PNG\r\n\x1a\n")
    return data if magic_ok else None


async def answer(image_b64: str, mime: str, question: str, name: str = "Bit", history: str = "") -> tuple[bool, str, Optional[str], str]:
    """-> (ok, say, details, seen)"""
    if decode(image_b64, mime) is None:
        return False, "I couldn't get a clear look at your screen.", None, ""
    question = " ".join((question or "help me with this").split())[:500].replace('"', "'")
    prompt = PROMPT.format(
        name=name, now=datetime.now().strftime("%A %d %B %Y, %H:%M"), question=question,
        history=f"Recent conversation, for context (oldest first):\n{history}\n" if history else "",
    )
    try:
        text = await agent.call_vision(prompt, image_b64, mime)
    except RuntimeError:
        return False, "I couldn't reach an AI that can see right now. Try again in a minute.", None, ""
    say, details, seen = parse(text)
    if not say:
        return False, "Hmm, I couldn't make sense of that one.", None, ""
    return True, say, details, seen


def sent_note() -> str:
    """One line for the chat panel when Bit starts looking: where the screenshot went (follow-ups don't repeat it)."""
    provider = PROVIDERS.get(agent.last_lane.split(":", 1)[0], "the AI")
    # "Bit doesn't save it", not "it isn't saved": the provider's own terms apply to what it receives.
    return f"📸 Screenshot sent to {provider} (Bit doesn't save it). Say “stop looking” when you're done."
