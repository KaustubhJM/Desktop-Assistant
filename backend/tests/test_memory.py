"""
Tests for Bit's memory (memory.py on LangGraph + conversation.py): threads,
short-term memory and its summary, long-term facts, persistence across
restarts, and moving the old chat log in. A fake model records every prompt.

Run:  venv\\Scripts\\python tests\\test_memory.py
"""

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import traceback
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
TMP = Path(tempfile.mkdtemp(prefix="memory-tests-"))
os.environ["REMINDER_DB_PATH"] = str(TMP / "start.db")

from langchain_core.messages import HumanMessage, SystemMessage  # noqa: E402

import actions  # noqa: E402
import agent  # noqa: E402
import conversation  # noqa: E402
import memory  # noqa: E402
import reminders  # noqa: E402
import schedule_store  # noqa: E402

REPLIES: list = []
PROMPTS: list[str] = []


async def fake_llm(prompt: str) -> str:
    PROMPTS.append(prompt)
    if not REPLIES:
        raise RuntimeError("no reply queued")
    r = REPLIES.pop(0)
    return r if isinstance(r, str) else json.dumps(r)


agent._call_llm = fake_llm
_n = 0


def fresh(name: str = "") -> Path:
    """A brand-new reminders + memory database."""
    global _n
    _n += 1
    path = TMP / f"m{_n}{name}.db"
    schedule_store.DB_PATH = path
    reminders.init_tables()
    conversation.init_tables()
    actions._pending = None
    REPLIES.clear()
    PROMPTS.clear()
    return path


def restart(path: Path) -> None:
    """What a backend restart does: everything reopened from disk."""
    memory._mem.close()
    memory._mem = None
    schedule_store.DB_PATH = path
    reminders.init_tables()
    conversation.init_tables()


def chat(text: str, reply: dict) -> dict:
    REPLIES.append({"mood": "neutral", "action": None, "follow_up": False, **reply})
    return asyncio.run(conversation.converse(text))


def history_part(prompt: str) -> str:
    """The "Recent conversation" section of a prompt."""
    return prompt.split("Recent conversation (oldest first):")[1].rsplit("\n\nUser: ", 1)[0]


def memory_part(prompt: str) -> str:
    return prompt.split("What you remember about the user")[1].split("Recent conversation")[0]


# ---------------------------------------------------------------- threads

def test_threads_keep_conversations_apart():
    fresh()
    chat("I'm planning a trip to Goa", {"say": "Fun! When?"})
    first = memory.current_thread()
    t2 = memory.new_thread()
    assert memory.current_thread() == t2["id"] != first
    chat("help me with recursion", {"say": "Sure."})
    assert "Goa" not in history_part(PROMPTS[-1]), "the new chat must not see the other one"
    memory.select_thread(first)
    chat("next weekend", {"say": "Nice."})
    assert "Goa" in history_part(PROMPTS[-1]) and "recursion" not in history_part(PROMPTS[-1])
    assert [m["text"] for m in conversation.recent_messages(10)] == ["I'm planning a trip to Goa", "Fun! When?", "next weekend", "Nice."]


def test_new_chat_is_named_after_its_first_message():
    fresh()
    t = memory.new_thread()
    assert t["title"] == memory.NEW_CHAT
    chat("Can you help me plan my DSA study schedule for next week please", {"say": "Yes!"})
    titles = {x["id"]: x["title"] for x in memory.list_threads()}
    assert titles[t["id"]] == "Can you help me plan my…", titles


def test_delete_a_thread():
    fresh()
    chat("secret plan", {"say": "ok"})
    t = memory.new_thread()
    chat("other topic", {"say": "ok"})
    assert conversation.delete_thread(t["id"])
    ids = [x["id"] for x in memory.list_threads()]
    assert t["id"] not in ids and memory.current_thread() in ids
    with schedule_store.get_conn() as c:
        assert c.execute("SELECT COUNT(*) FROM messages WHERE thread_id = ?", (t["id"],)).fetchone()[0] == 0
    assert not memory.thread_state(t["id"]).get("messages")


# ---------------------------------------------------------------- long-term facts

def test_facts_are_remembered_and_used_in_every_thread():
    fresh()
    r = chat("my exam is on the 20th", {"say": "Good luck!", "remember": [{"key": "exam date", "fact": "The user has an exam on 20 October."}]})
    assert r["remembered"] == ["The user has an exam on 20 October."], r
    memory.new_thread()
    chat("what should I do today?", {"say": "Study!"})
    assert "exam on 20 October" in memory_part(PROMPTS[-1]) and "[exam_date]" in memory_part(PROMPTS[-1]), memory_part(PROMPTS[-1])


def test_update_and_forget_facts():
    fresh()
    chat("I love lofi", {"say": "Nice", "remember": [{"key": "music", "fact": "The user loves lofi."}]})
    chat("actually I prefer jazz now", {"say": "Cool", "remember": [{"key": "music", "fact": "The user prefers jazz."}]})
    assert [f["fact"] for f in memory.facts()] == ["The user prefers jazz."]
    chat("forget what music I like", {"say": "Done", "forget": ["music"]})
    assert memory.facts() == []


def test_junk_memory_is_ignored():
    fresh()
    chat("hi", {"say": "hi", "remember": "not a list", "forget": "nope"})
    chat("hi", {"say": "hi", "remember": [{"key": "", "fact": "x"}, {"key": "a", "fact": ""}, "string", {"key": "k", "fact": "y" * 999}]})
    facts = memory.facts()
    assert len(facts) == 1 and len(facts[0]["fact"]) == memory.MAX_FACT_LEN, facts
    chat("hi", {"say": "hi", "remember": [{"key": f"k{i}", "fact": f"fact number {i}"} for i in range(10)]})
    assert len(memory.facts()) == 1 + conversation.MAX_REMEMBER_PER_TURN


def test_many_facts_show_the_relevant_ones():
    fresh()
    for i in range(40):
        memory.remember(f"fact_{i}", f"Unrelated fact number {i}.")
    memory.remember("pet", "The user has a cat named Mochi.")
    chat("tell me something about my cat", {"say": "Mochi!"})
    shown = memory_part(PROMPTS[-1])
    assert "Mochi" in shown and shown.count("\n- ") <= memory.MAX_FACTS_IN_PROMPT, shown


# ---------------------------------------------------------------- persistence

def test_everything_survives_a_restart():
    path = fresh("restart")
    chat("my friend Priyanshu is visiting", {"say": "Yay!", "remember": [{"key": "friend", "fact": "Priyanshu is the user's friend."}]})
    t = memory.new_thread("Coding help")
    chat("explain closures", {"say": "Sure."})
    restart(path)
    assert memory.current_thread() == t["id"] and {x["title"] for x in memory.list_threads()} >= {"Coding help"}
    chat("and in python?", {"say": "Same idea."})
    assert "explain closures" in history_part(PROMPTS[-1]) and "Priyanshu" in memory_part(PROMPTS[-1])
    assert [m["text"] for m in conversation.recent_messages(2)] == ["and in python?", "Same idea."]


# ---------------------------------------------------------------- short-term memory

def test_long_threads_get_summarised_after_answering():
    fresh()
    old = (memory.SUMMARIZE_AFTER, memory.KEEP_AFTER_SUMMARY)
    memory.SUMMARIZE_AFTER, memory.KEEP_AFTER_SUMMARY = 6, 2
    try:
        for i in range(3):
            chat(f"message {i} about the Goa trip", {"say": f"reply {i}"})
        # 4th turn: 7 messages in the thread once the user's is added -> summarise after answering.
        REPLIES.append({"say": "reply 3", "mood": "neutral", "action": None})
        REPLIES.append("The user is planning a Goa trip; Bit has been replying.")
        r = asyncio.run(conversation.converse("message 3"))
        assert r["say"] == "reply 3", "the answer comes first"
        assert "Fold the new messages into the summary" in PROMPTS[-1], "the summary call happens after the answer"
        state = memory.thread_state(memory.current_thread())
        assert state["summary"].startswith("The user is planning a Goa trip"), state
        assert len(state["messages"]) <= 3, [m.content for m in state["messages"]]
        chat("what were we talking about?", {"say": "Goa!"})
        assert "summarised: The user is planning a Goa trip" in history_part(PROMPTS[-1])
        assert len(conversation.recent_messages(100)) == 10, "the chat log the panel shows keeps everything"
    finally:
        memory.SUMMARIZE_AFTER, memory.KEEP_AFTER_SUMMARY = old


def test_summary_failure_never_breaks_a_reply():
    fresh()
    old = memory.SUMMARIZE_AFTER
    memory.SUMMARIZE_AFTER = 2
    try:
        chat("one", {"say": "a"})
        r = chat("two", {"say": "b"})  # summarising fails (no model reply queued): ignored
        assert r["say"] == "b" and len(memory.thread_state(memory.current_thread())["messages"]) == 4
    finally:
        memory.SUMMARIZE_AFTER = old


# ---------------------------------------------------------------- the old chat log

def test_old_chat_log_moves_into_the_first_thread():
    path = TMP / "legacy.db"
    with sqlite3.connect(path) as c:  # the messages table from before threads existed
        c.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, details TEXT, source TEXT, created_at TEXT NOT NULL)")
        now = datetime.now().isoformat()
        c.executemany("INSERT INTO messages (role, text, created_at) VALUES (?, ?, ?)", [("user", "I named you Bit yesterday", now), ("assistant", "I love it!", now)])
    memory._mem.close()
    memory._mem = None
    schedule_store.DB_PATH = path
    reminders.init_tables()
    conversation.init_tables()
    PROMPTS.clear()
    chat("do you remember your name?", {"say": "Bit!"})
    assert "I named you Bit yesterday" in history_part(PROMPTS[-1])
    assert [m["text"] for m in conversation.recent_messages(10)][:2] == ["I named you Bit yesterday", "I love it!"]
    conversation.init_tables()  # again: not seeded twice
    assert len(memory.thread_state(memory.DEFAULT_THREAD)["messages"]) == 4


# ---------------------------------------------------------------- existing behaviour, through the graph

def test_plain_yes_still_skips_the_model_and_is_remembered():
    fresh()
    reminders.add_item("Gym", "today", "18:00")
    chat("delete the gym reminder", {"say": "ok", "action": {"type": "delete", "id": 1}})
    n = len(PROMPTS)
    r = asyncio.run(conversation.converse("yes"))
    assert r["applied"] and len(PROMPTS) == n, "a plain yes is answered without the model"
    texts = [m.content for m in memory.thread_state(memory.current_thread())["messages"]]
    assert texts[-2:] == ["yes", r["say"]], texts


def test_offline_reply_is_kept_out_of_long_term_memory():
    fresh()
    r = asyncio.run(conversation.converse("hello?"))  # no reply queued: the model is "down"
    assert r["offline"] and r["remembered"] == [], r


def test_forget_everything():
    fresh()
    chat("I'm vegetarian", {"say": "Noted", "remember": [{"key": "diet", "fact": "The user is vegetarian."}]})
    memory.new_thread()
    chat("hi", {"say": "hi"})
    assert conversation.forget_everything() == 4
    assert memory.facts() == [] and [t["id"] for t in memory.list_threads()] == [memory.DEFAULT_THREAD]
    assert conversation.recent_messages(10) == [] and not memory.thread_state(memory.DEFAULT_THREAD).get("messages")


def test_langchain_model_runs_on_the_free_lanes():
    PROMPTS.clear()
    REPLIES.append("pong")
    out = memory.model.invoke([SystemMessage(content="Be brief."), HumanMessage(content="ping")])
    assert out.content == "pong" and PROMPTS[-1] == "Be brief.\n\nUser: ping", PROMPTS[-1]


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
            traceback.print_exc(limit=4)
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
