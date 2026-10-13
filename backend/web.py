"""
web.py

Answers that need the internet: "what's the weather in Pune", "who won the
match yesterday", "latest news about ISRO", "when does the new iPhone come
out". The conversation model decides a question needs looking up; this asks
a model with built-in web search (agent.call_search: Groq browser search /
Gemini Google Search, with the keys you already have) and turns the result
into a short spoken answer, a few details for the chat panel, and the
sources it used.

Only the question is sent — the same text you'd have sent the chat AI.
"Google it" style requests just open Google's results page in your browser.
"""

import re
import time
from datetime import datetime
from typing import Optional
from urllib.parse import urlencode, urlparse

import agent

MAX_QUERY = 200
MAX_SOURCES = 3

PROMPT = """Search the web to answer this question for the user. Now: {now} (the user's time zone: {tz}).
If the question needs a place and doesn't give one (e.g. "what's the weather"), assume the user's area from the time zone and say which place you used.
Use metric units (°C, km, kg) and the local currency, unless the question asks otherwise.
Question: {question}

Reply in exactly this format, nothing else:
SAY: <the answer in 1 or 2 short, natural spoken sentences, under 35 words; no markdown, no links, no citation marks>
DETAILS: <a few markdown bullet points with the key facts, numbers and dates, or the single word none>"""


def google_url(query: str) -> str:
    return "https://www.google.com/search?" + urlencode({"q": query})


def _clean(text: str) -> str:
    text = re.sub(r"【[^】]*】", "", text)  # gpt-oss citation marks: 【1†L5-L9】
    text = re.sub(r"\[\d+(?:,\s*\d+)*\]", "", text)  # [1], [2, 3]
    text = text.replace(" ", " ").replace(" ", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r" +([.,!?;:])", r"\1", text).strip()  # "5 PM ." -> "5 PM."


def parse(text: str) -> tuple[str, Optional[str]]:
    """'SAY: …\\nDETAILS: …' -> (say, details). Falls back to the first sentences if the format wasn't followed."""
    text = _clean(text)
    m = re.search(r"SAY:\s*(.+?)(?:\n\s*DETAILS:\s*(.*))?$", text, re.S | re.I)
    if m:
        say = " ".join(m.group(1).split())
        details = (m.group(2) or "").strip()
        return say, (None if details.lower() in ("", "none", "none.") else details)
    sentences = re.split(r"(?<=[.!?])\s+", " ".join(text.split()))
    say = " ".join(sentences[:2])
    return say, (text if len(sentences) > 2 else None)


def _sources_markdown(sources: list[dict]) -> Optional[str]:
    seen, links = set(), []
    for s in sources:
        url = (s.get("url") or "").strip()
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or "." not in host or re.fullmatch(r"[\d.]+", host) or host.endswith((".local", ".localhost")) or parsed.username:
            continue  # only ordinary public web pages (the app checks again before opening one)
        title = " ".join((s.get("title") or parsed.hostname).split())[:80].replace("[", "(").replace("]", ")")
        key = title.lower() if "vertexaisearch" in parsed.hostname else parsed.hostname.removeprefix("www.")
        if key in seen:
            continue
        seen.add(key)
        links.append(f"[{title}]({url})")
        if len(links) >= MAX_SOURCES:
            break
    return "Sources: " + " · ".join(links) if links else None


async def answer(query: object, question: str) -> tuple[bool, str, Optional[str]]:
    """-> (ok, say, details-with-sources)"""
    q = " ".join(str(query or question or "").split())[:MAX_QUERY]
    if not q:
        return False, "What should I look up?", None
    tz = time.strftime("%Z") or "unknown"
    prompt = PROMPT.format(now=datetime.now().strftime("%A %d %B %Y, %H:%M"), tz=tz, question=q if q.lower() in question.lower() else f"{question} (search for: {q})")
    try:
        result = await agent.call_search(prompt)
    except RuntimeError:
        return False, "I couldn't search the web right now — try again in a minute.", None
    say, details = parse(result.get("text") or "")
    if not say:
        return False, "I couldn't find a good answer to that.", None
    sources = _sources_markdown(result.get("sources") or [])
    details = "\n\n".join(x for x in (details, sources) if x) or None
    return True, say, details
