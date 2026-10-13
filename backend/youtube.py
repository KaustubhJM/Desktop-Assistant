"""
youtube.py

Find something on YouTube for "play lofi on YouTube" / "show me videos about
binary trees". The backend only works out the link; the desktop app opens it
in your default browser (and only ever opens youtube.com links).

With YOUTUBE_API_KEY in .env (YouTube Data API v3, free: about 100 searches a
day) it finds the best match and links straight to the video, which starts
playing. Without a key, or if the API fails or the daily quota is used up, it
links to YouTube's search results instead.

Only the search words are sent to YouTube, and only when you ask.
"""

import html
import os
import unicodedata
from typing import Optional
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv

load_dotenv()

YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "")
SEARCH_API = "https://www.googleapis.com/youtube/v3/search"
API_TIMEOUT_S = 6
MAX_QUERY = 120


def results_url(query: str) -> str:
    return "https://www.youtube.com/results?" + urlencode({"search_query": query})


def watch_url(video_id: str) -> str:
    return "https://www.youtube.com/watch?" + urlencode({"v": video_id})


def clean_query(query: object) -> str:
    q = " ".join(str(query or "").split())[:MAX_QUERY]
    return q


def spoken_title(title: str, limit: int = 60) -> str:
    """Video titles are long ("Song - Full Video | Artist | Label"); keep the first part.
    Emoji and other symbols are dropped: they're read aloud oddly, or not at all."""
    title = " ".join("".join(c for c in title if unicodedata.category(c) not in ("So", "Sk", "Cs", "Co")).split())
    short = title.split("|")[0].strip() or title.strip()
    if len(short) > limit:
        short = short[:limit].rsplit(" ", 1)[0] + "…"
    return short


async def top_video(query: str) -> Optional[dict]:
    """The best-matching video as {id, title, channel}, or None (no key, no match, API error)."""
    if not YOUTUBE_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=API_TIMEOUT_S) as client:
            resp = await client.get(
                SEARCH_API,
                params={"part": "snippet", "type": "video", "maxResults": 1, "q": query},
                # Key in a header, not the URL, so it never shows up in logs.
                headers={"x-goog-api-key": YOUTUBE_API_KEY},
            )
            resp.raise_for_status()
            items = resp.json().get("items") or []
    except Exception as err:  # network, quota (403), bad key (400)...
        print(f"[youtube] search failed, falling back to results page: {type(err).__name__}")
        return None
    if not items:
        return None
    video_id = (items[0].get("id") or {}).get("videoId")
    snippet = items[0].get("snippet") or {}
    if not isinstance(video_id, str) or not video_id.replace("-", "").replace("_", "").isalnum():
        return None
    return {
        "id": video_id,
        "title": html.unescape(snippet.get("title") or ""),
        "channel": html.unescape(snippet.get("channelTitle") or ""),
    }


async def find(query: object, play: bool = True) -> tuple[bool, str, Optional[str]]:
    """
    Returns (ok, message, url). url is what the app should open.
    play=True tries to go straight to the best video; otherwise search results.
    """
    q = clean_query(query)
    if not q:
        return False, "What should I look up on YouTube?", None
    if play:
        video = await top_video(q)
        if video:
            return True, f"Playing \"{spoken_title(video['title'])}\" on YouTube.", watch_url(video["id"])
    return True, f"Here's YouTube for \"{q}\".", results_url(q)
