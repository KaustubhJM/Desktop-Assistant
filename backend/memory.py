"""
memory.py

Bit's memory, built on LangGraph (with LangChain message types):

  Threads          separate conversations ("New chat"), each with its own
                   history. Kept by LangGraph's SQLite checkpointer, so they
                   survive restarts.
  Short-term       a thread's recent messages, as the model sees them. When a
                   thread gets long, the oldest messages are folded into a
                   running summary (so context stays small, nothing important
                   is lost).
  Long-term        facts about you ("exam on the 20th", "likes lofi", "friend
                   Priyanshu"), in LangGraph's SQLite store, shared by every
                   thread. The model adds/removes them as part of its normal
                   reply (conversation.py), so it costs no extra AI call.

Everything is stored on this laptop (bit-memory.db next to the reminders
database). Like chat history, the relevant parts are included in what's sent
to the AI provider for each reply. You can see and delete the long-term facts
in the chat panel's Settings.

The graph for one turn:   START -> respond -> summarize -> END
  respond    calls the model (the free-tier lanes in agent.py, through a
             LangChain chat model) with: the prompt conversation.py built,
             the thread's history and summary, and the long-term facts
  summarize  then, if the thread is long, folds the oldest messages into
             the summary (after answering, so you never wait for it)
The reply's actions (reminders, YouTube, search...) are then applied by
conversation.py exactly as before, and the final answer is written back into
the thread.
"""

import asyncio
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Callable, Optional, TypedDict

os.environ.setdefault("LANGSMITH_TRACING", "false")  # never send traces anywhere

from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, AnyMessage, BaseMessage, HumanMessage, RemoveMessage, SystemMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402
from langchain_core.runnables import RunnableConfig  # noqa: E402
from langgraph.checkpoint.sqlite import SqliteSaver  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402
from langgraph.graph.message import add_messages  # noqa: E402
from langgraph.store.base import BaseStore  # noqa: E402
from langgraph.store.sqlite import SqliteStore  # noqa: E402

import agent  # noqa: E402

DEFAULT_THREAD = "main"
FACTS = ("user", "facts")  # long-term memory namespace in the store
HISTORY_MESSAGES = 16  # what the model sees of the thread each turn
SUMMARIZE_AFTER = 30  # messages in a thread before the oldest are summarised...
KEEP_AFTER_SUMMARY = 16  # ...keeping this many recent ones verbatim
MAX_FACTS_IN_PROMPT = 30
MAX_FACT_LEN = 200
NEW_CHAT = "New chat"


# ------------------------------------------------------------ the model (LangChain)

def _as_prompt(messages: list[BaseMessage]) -> str:
    """Our lanes take one prompt string: system text first, then the conversation."""
    parts = []
    for m in messages:
        if isinstance(m, SystemMessage):
            parts.append(str(m.content))
        elif isinstance(m, HumanMessage):
            parts.append(f"User: {m.content}")
        else:
            parts.append(f"You: {m.content}")
    return "\n\n".join(parts)


class LaneChatModel(BaseChatModel):
    """A LangChain chat model over agent.py's free-tier lanes (Groq/Gemini rotation)."""

    @property
    def _llm_type(self) -> str:
        return "bit-free-lanes"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        # The graph runs in a worker thread (no event loop there), so this is safe.
        text = asyncio.run(agent._call_llm(_as_prompt(messages)))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        text = await agent._call_llm(_as_prompt(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])


model: BaseChatModel = LaneChatModel()


# ------------------------------------------------------------ the graph

class TurnState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    summary: str
    reply: Optional[str]  # the model's raw answer for this turn (None: no model call)
    offline: bool


SUMMARY_PROMPT = """You keep a running summary of a conversation between a user and Bit, their desktop robot.
Fold the new messages into the summary. Keep what matters for continuing the conversation: topics, what
the user wanted, decisions, open questions, anything Bit promised. Under 120 words, plain sentences.

Summary so far:
{summary}

New messages:
{lines}

Updated summary:"""


def _summarize(state: TurnState, config: RunnableConfig) -> dict:
    msgs = state.get("messages") or []
    if len(msgs) <= SUMMARIZE_AFTER or config.get("configurable", {}).get("skip_model"):
        return {}  # (turns answered without the model, like a plain "yes", don't summarise either)
    old = msgs[: len(msgs) - KEEP_AFTER_SUMMARY]
    lines = "\n".join(f"{'User' if isinstance(m, HumanMessage) else 'Bit'}: {m.content}" for m in old)
    try:
        summary = model.invoke([HumanMessage(content=SUMMARY_PROMPT.format(summary=state.get("summary") or "(none yet)", lines=lines))]).content
    except Exception:
        return {}  # no model right now: keep the messages, try again next turn (never breaks a reply)
    if not str(summary).strip():
        return {}
    return {"summary": str(summary).strip(), "messages": [RemoveMessage(id=m.id) for m in old]}


def _respond(state: TurnState, config: RunnableConfig, *, store: BaseStore) -> dict:
    conf = config.get("configurable", {})
    if conf.get("skip_model"):
        return {"reply": None, "offline": False}  # e.g. a plain "yes" to a pending confirmation
    msgs = state.get("messages") or []
    history, message = msgs[:-1][-HISTORY_MESSAGES:], msgs[-1].content if msgs else ""
    lines = [f"{'User' if isinstance(m, HumanMessage) else 'You'}: {m.content}" for m in history]
    summary = state.get("summary") or ""
    if summary:
        lines.insert(0, f"(Earlier in this conversation, summarised: {summary})")
    prompt: Callable[..., str] = conf["build_prompt"]
    text = prompt(history="\n".join(lines) or "(none yet)", message=str(message), memory=facts_for_prompt(str(message), store))
    try:
        reply = model.invoke([HumanMessage(content=text)]).content
        return {"reply": str(reply), "offline": False}
    except RuntimeError:
        return {"reply": None, "offline": True}


def _build_graph(saver: SqliteSaver, store: SqliteStore):
    g = StateGraph(TurnState)
    g.add_node("summarize", _summarize)
    g.add_node("respond", _respond)
    g.add_edge(START, "respond")
    g.add_edge("respond", "summarize")
    g.add_edge("summarize", END)
    return g.compile(checkpointer=saver, store=store)


# ------------------------------------------------------------ storage

class _Memory:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.saver = SqliteSaver(sqlite3.connect(str(path), check_same_thread=False))
        self.saver.setup()
        self.store = SqliteStore(sqlite3.connect(str(path), check_same_thread=False, isolation_level=None))
        self.store.setup()
        self.graph = _build_graph(self.saver, self.store)
        with self.conn:
            self.conn.execute(
                """CREATE TABLE IF NOT EXISTS bit_threads (
                       id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
            )
            self.conn.execute("CREATE TABLE IF NOT EXISTS bit_meta (key TEXT PRIMARY KEY, value TEXT)")
        if not self.threads():
            self._add_thread(DEFAULT_THREAD, "Chat")

    def close(self) -> None:
        for c in (self.conn, self.saver.conn, self.store.conn):
            try:
                c.close()
            except Exception:
                pass

    # threads
    def _add_thread(self, thread_id: str, title: str) -> None:
        now = _now()
        with self.conn:
            self.conn.execute("INSERT OR IGNORE INTO bit_threads VALUES (?, ?, ?, ?)", (thread_id, title, now, now))

    def threads(self) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM bit_threads ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]


_mem: Optional[_Memory] = None
_mem_lock = threading.Lock()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def db_path(schedule_db: Path) -> Path:
    """bit-memory.db next to the reminders database (tests get their own)."""
    override = os.getenv("REMINDER_MEMORY_DB")
    if override:
        return Path(override)
    return schedule_db.with_name(f"{schedule_db.stem}-memory.db") if schedule_db.name != "schedule.db" else schedule_db.with_name("bit-memory.db")


def open_memory(schedule_db: Path) -> None:
    """(Re)open the memory database that belongs to this reminders database."""
    global _mem
    with _mem_lock:
        path = db_path(Path(schedule_db))
        if _mem is not None and _mem.path == path:
            return
        if _mem is not None:
            _mem.close()
        _mem = _Memory(path)


def _m() -> _Memory:
    if _mem is None:
        raise RuntimeError("memory not opened (conversation.init_tables)")
    return _mem


def graph():
    return _m().graph


def config(thread_id: str, **extra: Any) -> dict:
    return {"configurable": {"thread_id": thread_id, **extra}}


async def run_turn(thread_id: str, message: HumanMessage, build_prompt: Callable[..., str], skip_model: bool = False) -> dict:
    """One turn through the graph: adds your message to the thread, summarises if long, asks the model."""
    m = _m()

    def run() -> dict:
        with m.lock:  # one turn at a time (typed + "Hey Bit" at once)
            return dict(m.graph.invoke({"messages": [message]}, config(thread_id, build_prompt=build_prompt, skip_model=skip_model)))

    return await asyncio.to_thread(run)


# ------------------------------------------------------------ threads

def list_threads() -> list[dict]:
    current = current_thread()
    return [{**t, "current": t["id"] == current} for t in _m().threads()]


def current_thread() -> str:
    m = _m()
    row = m.conn.execute("SELECT value FROM bit_meta WHERE key = 'current_thread'").fetchone()
    ids = {t["id"] for t in m.threads()}
    if row and row["value"] in ids:
        return row["value"]
    return next(iter(sorted(ids, key=lambda i: i != DEFAULT_THREAD)), DEFAULT_THREAD)


def select_thread(thread_id: str) -> bool:
    m = _m()
    if thread_id not in {t["id"] for t in m.threads()}:
        return False
    with m.conn:
        m.conn.execute("INSERT OR REPLACE INTO bit_meta VALUES ('current_thread', ?)", (thread_id,))
    return True


def new_thread(title: Optional[str] = None) -> dict:
    """Start a new conversation and make it the current one."""
    thread_id = uuid.uuid4().hex[:12]
    _m()._add_thread(thread_id, (title or NEW_CHAT).strip()[:60] or NEW_CHAT)
    select_thread(thread_id)
    return next(t for t in list_threads() if t["id"] == thread_id)


def rename_thread(thread_id: str, title: str) -> bool:
    title = " ".join(str(title).split())[:60]
    if not title:
        return False
    with _m().conn as c:
        return c.execute("UPDATE bit_threads SET title = ? WHERE id = ?", (title, thread_id)).rowcount > 0


def touch_thread(thread_id: str, first_message: Optional[str] = None) -> None:
    """Bump its "last used" time; a "New chat" is named after its first message."""
    with _m().conn as c:
        c.execute("UPDATE bit_threads SET updated_at = ? WHERE id = ?", (_now(), thread_id))
        if first_message:
            words = " ".join(first_message.split()).split(" ")
            title = " ".join(words[:6]) + ("…" if len(words) > 6 else "")
            c.execute("UPDATE bit_threads SET title = ? WHERE id = ? AND title = ?", (title[:60], thread_id, NEW_CHAT))


def delete_thread(thread_id: str) -> bool:
    """Forget a conversation entirely (its history and summary). Facts about you stay."""
    m = _m()
    with m.lock:
        m.saver.delete_thread(thread_id)
        with m.conn as c:
            gone = c.execute("DELETE FROM bit_threads WHERE id = ?", (thread_id,)).rowcount > 0
        if not m.threads():
            m._add_thread(DEFAULT_THREAD, "Chat")
        if current_thread() == thread_id or not select_thread(current_thread()):
            select_thread(m.threads()[0]["id"])
    return gone


def clear_thread(thread_id: str) -> None:
    """Empty a conversation but keep it (its history and summary go)."""
    _m().saver.delete_thread(thread_id)


def thread_state(thread_id: str) -> dict:
    snap = graph().get_state(config(thread_id))
    return dict(snap.values or {})


def append(thread_id: str, *messages: BaseMessage) -> None:
    """Add messages to a thread outside a model turn (the final answer, a search's result...)."""
    graph().update_state(config(thread_id), {"messages": list(messages)}, as_node="summarize")


def seed(thread_id: str, rows: list[dict]) -> None:
    """Move an existing chat log (before threads existed) into a thread's memory, once."""
    if thread_state(thread_id).get("messages") or not rows:
        return
    msgs = [HumanMessage(content=r["text"]) if r["role"] == "user" else AIMessage(content=r["text"]) for r in rows]
    graph().update_state(config(thread_id), {"messages": msgs}, as_node="summarize")


# ------------------------------------------------------------ long-term facts

_KEY = re.compile(r"[^a-z0-9_]+")


def _key(raw: object) -> str:
    return _KEY.sub("_", str(raw or "").strip().lower())[:60].strip("_")


def remember(key: object, fact: object) -> Optional[dict]:
    """Save (or update) one fact about the user. Junk is ignored."""
    k, f = _key(key), " ".join(str(fact or "").split())[:MAX_FACT_LEN]
    if not k or len(f) < 3:
        return None
    _m().store.put(FACTS, k, {"fact": f, "updated_at": _now()})
    return {"key": k, "fact": f}


def forget(key: object) -> bool:
    k = _key(key)
    if not k or _m().store.get(FACTS, k) is None:
        return False
    _m().store.delete(FACTS, k)
    return True


def facts() -> list[dict]:
    """Everything Bit remembers about you, newest first."""
    items = _m().store.search(FACTS, limit=1000)
    out = [{"key": i.key, "fact": i.value.get("fact", ""), "updated_at": i.value.get("updated_at", "")} for i in items]
    return sorted(out, key=lambda f: f["updated_at"], reverse=True)


def forget_everything() -> int:
    """All conversations and all facts."""
    m = _m()
    n = 0
    for f in facts():
        m.store.delete(FACTS, f["key"])
        n += 1
    for t in m.threads():
        m.saver.delete_thread(t["id"])
    with m.conn as c:
        c.execute("DELETE FROM bit_threads")
        c.execute("DELETE FROM bit_meta")
    m._add_thread(DEFAULT_THREAD, "Chat")
    return n


def facts_for_prompt(message: str, store: Optional[BaseStore] = None) -> str:
    """The facts to show the model: all of them, or (if there are many) the most relevant and recent."""
    all_facts = facts() if store is None or store is _m().store else [
        {"key": i.key, "fact": i.value.get("fact", ""), "updated_at": i.value.get("updated_at", "")} for i in store.search(FACTS, limit=1000)
    ]
    if len(all_facts) > MAX_FACTS_IN_PROMPT:
        words = {w for w in re.findall(r"[a-z0-9]{3,}", message.lower())}
        def score(f):  # mentioned now first, then most recent
            return (len(words & set(re.findall(r"[a-z0-9]{3,}", (f["key"] + " " + f["fact"]).lower()))), f["updated_at"])
        all_facts = sorted(all_facts, key=score, reverse=True)[:MAX_FACTS_IN_PROMPT]
    return "\n".join(f"- {f['fact']} [{f['key']}]" for f in all_facts) or "(nothing yet)"
