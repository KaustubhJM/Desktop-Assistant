"""
main.py

The glue. Run this with:  uvicorn main:app --reload

- WebSocket /ws        -> Electron overlay connects here, receives push
                           messages: {"type": "reminder"|"info", "text": ..., "urgency": ...}
- POST /schedule        -> add a task
- GET  /schedule        -> today's tasks
- PUT  /schedule/{id}   -> directly update a task (reschedule, mark done, etc.)
- POST /chat            -> one conversation turn (chat, questions, schedule
                           changes like "push my 3pm to 4"); see conversation.py
- GET/DELETE /conversation -> read a conversation / forget everything
- /threads, /memories   -> conversations ("New chat") and the facts Bit remembers about you (memory.py)
- POST /stt, /tts       -> local speech recognition and voice (speech.py)
- GET/POST /wake        -> "Hey Bit" hands-free listening on/off/muted (wake.py)
- POST /search         -> a web search answer (second step of a chat turn that needs one; web.py)
- POST /look           -> help with what's on screen, from a screenshot (second step; vision.py)
- GET/POST /activity    -> what you're doing (coding / watching / music), for the robot's mood (activity.py)
- GET  /next            -> what's the next task right now
"""

import asyncio
import hmac
import time
import os
import sys
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel

import activity
import beat
import gcal
import briefing
import conversation
import media
import memory
import occasions
import reminders
import schedule_store
import speech
import vision
import wake
from scheduler import create_scheduler

# Set by the desktop app on every launch. When set, every request must carry
# it, so other programs (and web pages) on this machine can't drive the
# backend. Left unset when you run `uvicorn main:app` by hand for development.
API_TOKEN = os.getenv("REMINDER_TOKEN", "")


def _token_ok(supplied: Optional[str]) -> bool:
    if not API_TOKEN:
        return True
    return supplied is not None and hmac.compare_digest(supplied, API_TOKEN)


def _exit_when_parent_goes_away():
    """The desktop app holds our stdin open; EOF means it quit or crashed."""
    sys.stdin.read()
    os._exit(0)


class ConnectionManager:
    """Tracks connected Electron overlay clients and broadcasts to all of them."""

    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, payload: dict):
        for ws in list(self.active):
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(ws)


manager = ConnectionManager()


async def push_reminder(text: str, task: dict, urgency: str):
    await manager.broadcast({
        "type": "reminder", "text": text, "urgency": urgency, "item_id": task["item_id"],
        "occurrence": task["occurrence"], "kind": task["kind"], "title": task["title"],
    })


async def push_summary(text: str, missed: list):
    await manager.broadcast({"type": "reminder", "text": text, "urgency": "normal", "kind": "missed"})


scheduler, check_now = create_scheduler(on_reminder=push_reminder, on_summary=push_summary)

_loop: Optional[asyncio.AbstractEventLoop] = None


def _push_from_thread(event: dict) -> None:
    """Called from the wake-word / activity / beat threads; hand the event to the server's loop."""
    if event.get("type") == "activity":
        # Dancing in time: listen for the beat only while a song plays.
        if event.get("music") and activity_watcher.enabled:
            beat_listener.start()
        else:
            beat_listener.stop()
    if _loop is not None:
        asyncio.run_coroutine_threadsafe(manager.broadcast(event), _loop)


beat_listener = beat.BeatListener(lambda b: _push_from_thread({"type": "beat", "text": "", **b}))


activity_watcher = activity.ActivityWatcher(_push_from_thread)
wake_listener = wake.WakeListener(_push_from_thread, lambda audio, hint, quality, words: speech.stt.transcribe_pcm(audio, quality, hint, words))


@asynccontextmanager
async def lifespan(app: FastAPI):
    reminders.init_tables()
    conversation.init_tables()
    gcal.init_tables()
    if os.getenv("REMINDER_WATCH_STDIN") == "1":
        # Never outlive the desktop app, even if it's killed without cleanup.
        threading.Thread(target=_exit_when_parent_goes_away, daemon=True).start()
    global _loop
    _loop = asyncio.get_running_loop()
    scheduler.start()
    yield
    scheduler.shutdown()
    wake_listener.stop()
    activity_watcher.enabled = False
    beat_listener.stop()
    media.helper.stop()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def require_token(request: Request, call_next):
    auth = request.headers.get("authorization", "")
    supplied = auth[len("Bearer "):] if auth.startswith("Bearer ") else None
    if not _token_ok(supplied):
        return JSONResponse({"detail": "missing or invalid token"}, status_code=401)
    return await call_next(request)


# HH:MM (24h), normalized ("9:00" -> "09:00"). Anything unparseable like
# "4pm" is rejected with a 422 before it ever reaches the database.
TimeStr = Annotated[str, AfterValidator(schedule_store.normalize_time)]


class TaskIn(BaseModel):
    title: str
    task_date: str  # YYYY-MM-DD
    start_time: TimeStr
    end_time: Optional[TimeStr] = None
    priority: str = "normal"


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    start_time: Optional[TimeStr] = None
    end_time: Optional[TimeStr] = None
    priority: Optional[str] = None
    done: Optional[int] = None


class ChatIn(BaseModel):
    text: str
    name: str = "Bit"
    source: str = "typed"  # typed | voice
    mood: str = ""  # how the robot feels right now (app/src/main/mood.ts), a few words
    focus: str = ""  # a focus session's state, if one is running (app/src/main/focus.ts)
    image: Optional[str] = None  # a screenshot (base64) while Bit is looking at your screen; never saved
    mime: str = "image/jpeg"


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    # Browsers can't set headers on a WebSocket, so the token rides in the URL.
    if not _token_ok(websocket.query_params.get("token")):
        await websocket.close(code=1008)
        return
    await manager.connect(websocket)
    try:
        while True:
            # We don't currently expect messages from the client over the
            # socket (chat updates go through POST /chat), but we keep the
            # loop alive to detect disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


class ItemIn(BaseModel):
    title: str
    due_date: str = "today"
    due_time: Optional[str] = None
    rrule: Optional[str] = None
    notes: Optional[str] = None


def _bad(err: ValueError):
    raise HTTPException(status_code=422, detail=str(err))


@app.post("/items")
def add_item(item: ItemIn):
    try:
        return {"id": reminders.add_item(item.title, item.due_date, item.due_time, item.rrule, notes=item.notes)}
    except ValueError as err:
        _bad(err)


@app.get("/items")
def list_items(days: int = 7):
    from datetime import date, timedelta
    d = date.today()
    return reminders.occurrences(d, d + timedelta(days=max(0, min(days, 60))))


@app.delete("/items/{item_id}")
def delete_item(item_id: int):
    return {"deleted": reminders.delete_item(item_id)}


@app.post("/items/{item_id}/complete")
def complete_item(item_id: int, done: bool = True, date: Optional[str] = None):
    return {"ok": reminders.complete(item_id, date, done)}


@app.post("/items/{item_id}/snooze")
def snooze_item(item_id: int, occurrence: str, minutes: int = 10):
    try:
        return {"until": reminders.snooze(item_id, occurrence, minutes)}
    except ValueError as err:
        _bad(err)


@app.get("/scheduler/status")
def scheduler_status():
    return {"last_check": reminders.get_meta("last_check")}


@app.post("/scheduler/check")
async def scheduler_check():
    """Check for due reminders now (the app calls this after waking from sleep)."""
    return await check_now()


@app.get("/schedule")
def list_today():
    """Today's occurrences in the older task shape (used by the chat panel's Today tab)."""
    return [
        {"id": o["item_id"], "title": o["title"], "task_date": o["date"], "start_time": o["time"] or "",
         "end_time": None, "priority": o["priority"], "done": int(o["done"])}
        for o in reminders.today()
    ]


@app.get("/next")
def next_task():
    from datetime import datetime as _dt
    now = _dt.now().strftime("%H:%M")
    upcoming = [o for o in reminders.today() if not o["done"] and o["time"] and o["time"] >= now]
    return upcoming[0] if upcoming else {}


@app.get("/conversation")
def get_conversation(limit: int = 100, thread_id: Optional[str] = None):
    """A conversation's chat log (the current one by default), oldest first."""
    return conversation.recent_messages(min(max(limit, 1), 500), thread_id)


@app.delete("/conversation")
def delete_conversation(scope: str = "all"):
    """scope=all: forget everything (every conversation and every fact about you); scope=thread: empty the current conversation."""
    if scope == "thread":
        return {"deleted": conversation.clear_messages()}
    return {"deleted": conversation.forget_everything()}


# ---- conversations (threads) and what Bit remembers about you (memory.py)

class ThreadIn(BaseModel):
    title: Optional[str] = None


@app.get("/threads")
def get_threads():
    return memory.list_threads()


@app.post("/threads")
def create_thread(req: ThreadIn):
    """Start a new conversation (it becomes the current one)."""
    return memory.new_thread(req.title)


@app.post("/threads/{thread_id}/select")
def select_thread(thread_id: str):
    if not memory.select_thread(thread_id):
        raise HTTPException(status_code=404, detail="no such conversation")
    return memory.list_threads()


@app.patch("/threads/{thread_id}")
def rename_thread(thread_id: str, req: ThreadIn):
    if not memory.rename_thread(thread_id, req.title or ""):
        raise HTTPException(status_code=404, detail="no such conversation (or empty title)")
    return memory.list_threads()


@app.delete("/threads/{thread_id}")
def remove_thread(thread_id: str):
    conversation.delete_thread(thread_id)
    return memory.list_threads()


@app.get("/memories")
def get_memories():
    """Facts Bit remembers about you (shared by all conversations)."""
    return memory.facts()


class FactIn(BaseModel):
    fact: str


@app.put("/memories/{key}")
def set_memory(key: str, req: FactIn):
    """Add or correct something Bit remembers about you."""
    if not memory.remember(key, req.fact):
        raise HTTPException(status_code=400, detail="needs a key and a fact")
    return memory.facts()


@app.delete("/memories/{key}")
def forget_memory(key: str):
    if not memory.forget(key):
        raise HTTPException(status_code=404, detail="no such memory")
    return memory.facts()


@app.post("/chat")
async def chat(msg: ChatIn):
    """
    One conversation turn: chat, questions, and schedule changes ("push my
    3pm to 4"). The reply is short enough to speak; longer answers come back
    in "details" for the chat panel. Schedule actions are validated by
    actions.py before anything is saved.
    """
    if msg.image and len(msg.image) > vision.MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise HTTPException(status_code=413, detail="screenshot too large")
    result = await conversation.converse(msg.text, name=msg.name, source=msg.source, mood=msg.mood[:120], focus=msg.focus[:200],
                                         image=msg.image or None, mime=msg.mime)
    # "reply" kept for older clients.
    return {**result, "reply": result["say"]}


@app.get("/speech/status")
def speech_status():
    return speech.available()


@app.post("/stt")
async def speech_to_text(request: Request, quality: str = "fast"):
    """Raw 16-bit PCM WAV in the body -> transcript. Runs locally (faster-whisper)."""
    body = await request.body()
    if not body or len(body) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="expected a WAV body under 20 MB")
    try:
        return await run_in_threadpool(speech.stt.transcribe, body, quality)
    except (ValueError, EOFError) as err:
        raise HTTPException(status_code=400, detail=f"bad audio: {err}")


class TtsIn(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.post("/tts")
async def text_to_speech(req: TtsIn):
    """Text -> WAV audio. Runs locally (Kokoro)."""
    text = req.text.strip()
    if not text or len(text) > 1000:
        raise HTTPException(status_code=400, detail="text must be 1-1000 characters")
    wav = await run_in_threadpool(speech.tts.synthesize, text, req.voice, min(max(req.speed, 0.7), 1.4))
    return Response(content=wav, media_type="audio/wav")


class WakeIn(BaseModel):
    enabled: Optional[bool] = None
    muted: Optional[bool] = None
    name: Optional[str] = None
    quality: Optional[str] = None  # speech recognition: fast | accurate | online


@app.get("/wake")
def wake_status():
    return wake_listener.status()


@app.post("/wake")
async def set_wake(req: WakeIn):
    """Turn "Hey Bit" listening on/off, mute it while the robot talks, or follow a rename."""
    if req.name is not None:
        wake_listener.set_names([req.name])
    if req.muted is not None:
        wake_listener.set_muted(req.muted)
    if req.quality in ("fast", "accurate", "online"):
        wake_listener.quality = req.quality
    if req.enabled is True:
        # Keep the recogniser loaded while hands-free is on, and load it now,
        # so the first "Hey Bit" after a quiet spell isn't slow.
        speech.stt.keep_warm = True
        threading.Thread(target=speech.stt.transcribe_pcm, args=(np.zeros(8000, np.float32),), daemon=True).start()
        return await run_in_threadpool(wake_listener.start)
    if req.enabled is False:
        speech.stt.keep_warm = False
        return await run_in_threadpool(wake_listener.stop)
    return wake_listener.status()


class SearchIn(BaseModel):
    query: str
    question: str = ""
    thread_id: Optional[str] = None  # the conversation it was asked in


@app.post("/search")
async def search(req: SearchIn):
    """Step two of a search turn (see /chat's "search"): look it up on the web and answer."""
    query = " ".join(req.query.split())[:200]
    if not query:
        raise HTTPException(status_code=400, detail="empty query")
    return await conversation.search_answer(query, req.question[:2000] or query, req.thread_id)


class LookIn(BaseModel):
    image: str  # base64 screenshot; used once for the answer, never saved
    mime: str = "image/jpeg"
    question: str = ""
    name: str = "Bit"
    thread_id: Optional[str] = None


@app.post("/look")
async def look(req: LookIn):
    """Step two of a "help me with this" turn (see /chat's "look"): answer from a screenshot."""
    if len(req.image) > vision.MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise HTTPException(status_code=413, detail="screenshot too large")
    return await conversation.look_answer(req.image, req.mime, req.question[:500], req.name[:40] or "Bit", req.thread_id)


class NoteIn(BaseModel):
    text: str
    details: Optional[str] = None


@app.post("/conversation/note")
def add_note(req: NoteIn):
    """Something the robot said on its own (a check-in): into the current conversation, so a reply makes sense."""
    text = req.text.strip()[:1000]
    if not text:
        raise HTTPException(status_code=400, detail="empty note")
    return {"id": conversation.add_note(text, (req.details or None) and req.details[:4000])}


class BriefingIn(BaseModel):
    name: str = "Bit"


@app.post("/briefing")
async def morning_briefing(req: BriefingIn):
    """The morning hello: weather, today's tasks, special days (briefing.py)."""
    return await briefing.morning(req.name[:24] or "Bit")


@app.get("/foreground")
def foreground_window():
    """Where the window in front is (geometry only, never its title), for the robot to perch on."""
    return activity.foreground_rect()


# ---- Google Calendar (gcal.py)

@app.get("/calendar/status")
def calendar_status():
    return gcal.status()


@app.post("/calendar/connect")
def calendar_connect():
    """Opens Google's sign-in in your browser; poll /calendar/status until it's done."""
    if not gcal.status()["connecting"]:
        threading.Thread(target=gcal.connect, daemon=True).start()
        time.sleep(0.3)
    return gcal.status()


@app.post("/calendar/disconnect")
def calendar_disconnect():
    return gcal.disconnect()


@app.get("/calendar/events")
def calendar_events(days: int = 7):
    """Upcoming events, shaped for the Today tab (read-only)."""
    return [
        {"id": e["id"], "title": e["title"], "date": e["start"].date().isoformat(),
         "time": None if e["all_day"] else e["start"].strftime("%H:%M"), "location": e["location"]}
        for e in gcal.upcoming(min(max(days, 0), 30))
    ]


@app.get("/occasion")
def occasion():
    """Today's special day (festival, your birthday) for the robot's badge, or null."""
    return occasions.today()


class ActivityIn(BaseModel):
    enabled: bool


@app.get("/activity")
def activity_status():
    return activity_watcher.status()


@app.post("/activity")
def set_activity(req: ActivityIn):
    """Follow what you're doing (app in front + what's playing) for the robot's mood, or stop."""
    return activity_watcher.start() if req.enabled else activity_watcher.stop()
