"""
agent.py

The LLM plumbing: provider calls with fallback, plus decide_reminder_text()
(phrase a reminder). Conversations live in conversation.py, which uses
_call_llm() from here.

Design choice: the LLM never touches the database directly. It only returns
JSON, and actions.py validates and applies it. This keeps the "brain"
swappable without touching storage logic.

Free tiers as routing lanes: each model on each provider has its own free
allowance (Gemini 2.5 Flash: 20 requests a day; Groq: 8,000 tokens a minute
per model), and a chatty conversation runs through one allowance quickly.
So we try a list of lanes, fastest first, and when one says "slow down"
(429) we skip it until it has reset (they tell us when), then use the next.
Override the list with LLM_LANES in .env, e.g.
  LLM_LANES=groq:openai/gpt-oss-120b,gemini:gemini-3.5-flash-lite

Web search (call_search) uses the providers' own built-in search the same
way: Groq's browser search on gpt-oss, Gemini's Google Search grounding.
Same keys, same lanes idea (WEB_SEARCH_LANES), and a model resting after a
429 rests for both, since they share its free allowance.

call_vision answers about a screenshot ("help me with this", vision.py) with
the models that can see (VISION_LANES).
"""

import asyncio
import json
import os
import re
import time
import weakref

import httpx
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

# Fastest first; quality is similar for what the robot needs. Models get
# retired now and then: https://console.groq.com/docs/models,
# https://ai.google.dev/gemini-api/docs/models
DEFAULT_LANES = (
    "groq:openai/gpt-oss-120b,"
    "gemini:gemini-3.5-flash-lite,"
    "groq:qwen/qwen3.8-27b,"
    "gemini:gemini-3.5-flash,"
    "groq:openai/gpt-oss-20b,"
    "gemini:gemini-2.5-flash"
)
LANES: list[tuple[str, str]] = [
    tuple(lane.strip().split(":", 1))  # type: ignore[misc]
    for lane in (os.getenv("LLM_LANES") or DEFAULT_LANES).split(",")
    if ":" in lane
]

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
TIMEOUT_S = 15

# Fast ones first: a search answer spends a lot of Groq's per-minute tokens,
# and Gemini 2.5 with Google Search takes 7–15 s.
DEFAULT_SEARCH_LANES = (
    "groq:openai/gpt-oss-120b,"
    "groq:openai/gpt-oss-20b,"
    "gemini:gemini-3.5-flash-lite,"
    "gemini:gemini-2.5-flash,"
    "gemini:gemini-3.5-flash"
)
SEARCH_LANES: list[tuple[str, str]] = [
    tuple(lane.strip().split(":", 1))  # type: ignore[misc]
    for lane in (os.getenv("WEB_SEARCH_LANES") or DEFAULT_SEARCH_LANES).split(",")
    if ":" in lane
]
SEARCH_TIMEOUT_S = 20

# Connections are kept open between calls: from here (India) a fresh HTTPS
# connection to Groq costs ~0.5 s more than a reused one, on every call, and a
# spoken turn makes two (speech recognition, then the reply). One pool per
# event loop (the server has one; tests make several).
_pools: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = weakref.WeakKeyDictionary()
_AsyncClient = httpx.AsyncClient


class _pooled:
    """`async with _pooled(timeout) as client:` like a fresh httpx.AsyncClient, but on the shared, kept-open pool."""

    def __init__(self, timeout: float):
        self.timeout = timeout

    async def __aenter__(self) -> "_pooled":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    @staticmethod
    def client() -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        client = _pools.get(loop)
        if client is None or client.is_closed:
            client = _pools[loop] = _AsyncClient(limits=httpx.Limits(keepalive_expiry=120))
        return client

    async def post(self, url: str, **kwargs) -> httpx.Response:
        client = self.client()
        try:
            return await client.post(url, timeout=self.timeout, **kwargs)
        except httpx.RemoteProtocolError:
            # The server closed the idle connection just as it was reused: once more, on a new one.
            return await client.post(url, timeout=self.timeout, **kwargs)


# lane -> time.time() until which we leave it alone
_resting: dict[str, float] = {}
# which lane answered last (for logs and tests)
last_lane: str = ""


async def _call_gemini(prompt: str, model: str) -> str:
    body: dict = {"contents": [{"parts": [{"text": prompt}]}]}
    if model.startswith("gemini-3"):
        body["generationConfig"] = {"thinkingConfig": {"thinkingLevel": "low"}}  # quick replies
    async with _pooled(TIMEOUT_S) as client:
        resp = await client.post(
            GEMINI_URL.format(model=model),
            # Key goes in a header, not the URL: httpx puts the URL into its
            # error messages, and those end up in logs.
            headers={"x-goog-api-key": GEMINI_API_KEY},
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()
        parts = data["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts if not p.get("thought"))


async def _call_groq(prompt: str, model: str) -> str:
    async with _pooled(TIMEOUT_S) as client:
        resp = await client.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                # gpt-oss thinks before answering; a little is plenty here and keeps replies fast.
                **({"reasoning_effort": "low"} if "gpt-oss" in model else {}),
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def _rest_for(resp: httpx.Response) -> float:
    """How long to leave a lane alone after an error, in seconds."""
    code = resp.status_code
    if code == 429:
        try:  # Groq: "retry-after: 7"; Gemini: details[].retryDelay "2479s"
            if resp.headers.get("retry-after"):
                return max(1.0, float(resp.headers["retry-after"]))
            for d in resp.json().get("error", {}).get("details", []):
                m = re.fullmatch(r"([\d.]+)s", str(d.get("retryDelay", "")))
                if m:
                    return max(1.0, float(m.group(1)))
        except (ValueError, json.JSONDecodeError):
            pass
        return 60.0
    if code in (401, 403):
        return 3600.0  # bad key: no point retrying every turn
    if code == 404:
        return 86400.0  # model retired
    return 20.0  # 5xx, odd 400s


async def _route(lanes: list[tuple[str, str]], call):
    """Try each lane in order, skipping ones that are resting; the first answer wins."""
    global last_lane
    now = time.time()
    usable = [(p, m) for p, m in lanes if (p == "gemini" and GEMINI_API_KEY) or (p == "groq" and GROQ_API_KEY)]
    ready = [lane for lane in usable if _resting.get(":".join(lane), 0) <= now]
    if not ready and usable:
        # Everything is resting: try the one that recovers soonest anyway.
        ready = [min(usable, key=lambda lane: _resting.get(":".join(lane), 0))]
    errors = []
    for provider, model in ready:
        name = f"{provider}:{model}"
        try:
            result = await call(provider, model)
            last_lane = name
            return result
        except httpx.HTTPStatusError as e:
            _resting[name] = time.time() + _rest_for(e.response)
            errors.append(f"{name} {e.response.status_code}")
        except Exception as e:  # timeout, network, unexpected response shape
            _resting[name] = time.time() + 20
            errors.append(f"{name} {type(e).__name__}")
    if errors:
        print(f"[llm] {', '.join(errors)}")
    raise RuntimeError(f"All LLM providers failed: {', '.join(errors) or 'no API keys'}")


async def _call_llm(prompt: str) -> str:
    """A plain answer from the first free lane that's up."""
    return await _route(LANES, lambda p, m: _call_gemini(prompt, m) if p == "gemini" else _call_groq(prompt, m))


async def warm() -> None:
    """Connect to the first chat lane ahead of time (a spoken command is on its
    way). An empty request, no key or text: it only opens the connection."""
    now = time.time()
    for provider, model in LANES:
        if _resting.get(f"{provider}:{model}", 0) > now or not (GROQ_API_KEY if provider == "groq" else GEMINI_API_KEY):
            continue
        url = "https://api.groq.com/openai/v1/models" if provider == "groq" else "https://generativelanguage.googleapis.com/v1beta/models"
        try:
            await _pooled.client().get(url, timeout=5)
        except Exception:
            pass
        return


# ----------------------------------------------------------------- web search

async def _search_gemini(prompt: str, model: str) -> dict:
    """Gemini with Google Search grounding -> {text, sources: [{title, url}]}."""
    async with _pooled(SEARCH_TIMEOUT_S) as client:
        resp = await client.post(
            GEMINI_URL.format(model=model),
            headers={"x-goog-api-key": GEMINI_API_KEY},
            json={"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]},
        )
        resp.raise_for_status()
        cand = resp.json()["candidates"][0]
    text = "".join(p.get("text", "") for p in cand["content"]["parts"] if not p.get("thought"))
    chunks = (cand.get("groundingMetadata") or {}).get("groundingChunks") or []
    sources = [{"title": c["web"].get("title") or "", "url": c["web"].get("uri") or ""} for c in chunks if c.get("web")]
    return {"text": text, "sources": sources}


async def _search_groq(prompt: str, model: str) -> dict:
    """gpt-oss on Groq with its built-in browser search -> {text, sources: [{title, url}]}."""
    async with _pooled(SEARCH_TIMEOUT_S) as client:
        resp = await client.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "tools": [{"type": "browser_search"}],
                "tool_choice": "required",
                "reasoning_effort": "low",
            },
        )
        resp.raise_for_status()
        msg = resp.json()["choices"][0]["message"]
    sources = []
    for tool in msg.get("executed_tools") or []:
        for r in ((tool.get("search_results") or {}).get("results") or []):
            sources.append({"title": r.get("title") or "", "url": r.get("url") or ""})
    return {"text": msg.get("content") or "", "sources": sources}


async def call_search(prompt: str) -> dict:
    """Answer using a live web search. Raises RuntimeError if no lane could."""
    return await _route(SEARCH_LANES, lambda p, m: _search_gemini(prompt, m) if p == "gemini" else _search_groq(prompt, m))


# ----------------------------------------------------------------- vision

# Models that can read a screenshot ("help me with this"). All read code and
# error text well; fastest first (Flash-Lite ~2 s, Qwen on Groq thinks first,
# ~2-7 s). VISION_LANES in .env overrides it.
DEFAULT_VISION_LANES = (
    "gemini:gemini-3.5-flash-lite,"
    "groq:qwen/qwen3.8-27b,"
    "gemini:gemini-3.5-flash,"
    "gemini:gemini-2.5-flash"
)
VISION_LANES: list[tuple[str, str]] = [
    tuple(lane.strip().split(":", 1))  # type: ignore[misc]
    for lane in (os.getenv("VISION_LANES") or DEFAULT_VISION_LANES).split(",")
    if ":" in lane
]
VISION_TIMEOUT_S = 40


async def _vision_gemini(prompt: str, image_b64: str, mime: str, model: str) -> str:
    body: dict = {"contents": [{"parts": [{"inline_data": {"mime_type": mime, "data": image_b64}}, {"text": prompt}]}]}
    if model.startswith("gemini-3"):
        body["generationConfig"] = {"thinkingConfig": {"thinkingLevel": "low"}}
    async with _pooled(VISION_TIMEOUT_S) as client:
        resp = await client.post(GEMINI_URL.format(model=model), headers={"x-goog-api-key": GEMINI_API_KEY}, json=body)
        resp.raise_for_status()
        parts = resp.json()["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))


async def _vision_groq(prompt: str, image_b64: str, mime: str, model: str) -> str:
    async with _pooled(VISION_TIMEOUT_S) as client:
        resp = await client.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
                ]}],
                "reasoning_format": "hidden",  # Qwen thinks first; only the answer comes back
            },
        )
        resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"] or ""


async def call_vision(prompt: str, image_b64: str, mime: str = "image/jpeg") -> str:
    """An answer about an image. Raises RuntimeError if no lane could."""
    return await _route(VISION_LANES, lambda p, m: _vision_gemini(prompt, image_b64, mime, m) if p == "gemini" else _vision_groq(prompt, image_b64, mime, m))


def _strip_json_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return text.strip()


async def decide_reminder_text(task: dict, context: dict) -> str:
    """
    context can include things like: minutes_until_start, is_15_min_warning,
    idle_minutes (if you wire up activity detection later), etc.
    """
    prompt = f"""You are a friendly, concise desktop reminder character.
Task: "{task['title']}" starting at {task['start_time']} (priority: {task['priority']}).
Context: {json.dumps(context)}

Write ONE short reminder sentence (under 20 words) to show in a speech bubble.
Be natural, not robotic. No quotes, no emoji, just the sentence."""
    text = await _call_llm(prompt)
    return text.strip().strip('"')
