"""
Reminder system tests with a simulated clock — no waiting, no network.

    venv\\Scripts\\python tests\\test_reminders.py

Each test gets a fresh throwaway database. The LLM is faked (or made to fail)
so reminder wording is deterministic.
"""

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
TMP = Path(tempfile.mkdtemp(prefix="reminder-tests-"))
os.environ["REMINDER_DB_PATH"] = str(TMP / "test.db")

import agent  # noqa: E402
import actions  # noqa: E402
import conversation  # noqa: E402
import reminders  # noqa: E402
import schedule_store  # noqa: E402
import scheduler  # noqa: E402

LLM_REPLIES: list = []


async def fake_llm(prompt: str) -> str:
    if not LLM_REPLIES:
        return "Your reminder is here."
    item = LLM_REPLIES.pop(0)
    if isinstance(item, Exception):
        raise item
    return item if isinstance(item, str) else json.dumps(item)


agent._call_llm = fake_llm


def fresh_db() -> None:
    path = TMP / f"t{datetime.now().timestamp()}.db"
    schedule_store.DB_PATH = path
    reminders.init_tables()
    conversation.init_tables()
    actions._pending = None
    LLM_REPLIES.clear()


class Recorder:
    def __init__(self):
        self.sent: list[tuple[str, str, str]] = []  # (title, kind, occurrence)
        self.summaries: list[str] = []

    async def reminder(self, text, n, urgency):
        self.sent.append((n["title"], n["kind"].split(":")[0], n["occurrence"]))

    async def summary(self, text, missed):
        self.summaries.append(text)


def run(rec: Recorder, at: datetime) -> dict:
    return asyncio.run(scheduler.check(rec.reminder, rec.summary, now=at))


def tick(rec: Recorder, start: datetime, minutes: int, step_s: int = 20) -> None:
    """Run the scheduler every step_s seconds for `minutes` simulated minutes."""
    t = start
    end = start + timedelta(minutes=minutes)
    while t <= end:
        run(rec, t)
        t += timedelta(seconds=step_s)


D = date(2026, 10, 12)


def at(h: int, m: int = 0, day: date = D) -> datetime:
    return datetime(day.year, day.month, day.day, h, m)


# ---------------------------------------------------------------------- tests

def test_one_time_fires_warning_and_start_exactly_once():
    fresh_db()
    reminders.add_item("DSA practice", D.isoformat(), "19:00")
    rec = Recorder()
    reminders.set_meta("last_check", at(18, 30).isoformat())
    tick(rec, at(18, 30), 45)
    assert rec.sent == [("DSA practice", "warn", "2026-10-12T19:00"), ("DSA practice", "start", "2026-10-12T19:00")], rec.sent


def test_two_checks_at_the_same_moment_never_duplicate():
    fresh_db()
    reminders.add_item("Gym", D.isoformat(), "18:00", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(17, 59).isoformat())
    run(rec, at(18, 0))
    reminders.set_meta("last_check", at(17, 59).isoformat())  # a second, overlapping check
    run(rec, at(18, 0))
    assert rec.sent == [("Gym", "start", "2026-10-12T18:00")], rec.sent


def test_daily_repeat_fires_each_day():
    fresh_db()
    reminders.add_item("Plan tomorrow", D.isoformat(), "21:00", "FREQ=DAILY", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(20, 59).isoformat())
    for day in range(3):
        d = D + timedelta(days=day)
        reminders.set_meta("last_check", at(20, 59, d).isoformat())
        tick(rec, at(20, 59, d), 3)
    assert [s[2] for s in rec.sent] == ["2026-10-12T21:00", "2026-10-13T21:00", "2026-10-14T21:00"], rec.sent


def test_weekday_repeat_skips_weekend():
    fresh_db()
    reminders.add_item("Standup", D.isoformat(), "09:30", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", remind_before=None)
    occ = reminders.occurrences(D, D + timedelta(days=6))  # Mon 12 .. Sun 18 Oct 2026
    assert [o["date"] for o in occ] == ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"], occ
    assert occ[0]["repeat_text"] == "every weekday", occ[0]["repeat_text"]


def test_completing_todays_repeat_silences_only_today():
    fresh_db()
    iid = reminders.add_item("Stretch", D.isoformat(), "16:00", "FREQ=DAILY", remind_before=None)
    reminders.complete(iid, D.isoformat())
    rec = Recorder()
    reminders.set_meta("last_check", at(15, 59).isoformat())
    tick(rec, at(15, 59), 3)
    reminders.set_meta("last_check", at(15, 59, D + timedelta(days=1)).isoformat())
    tick(rec, at(15, 59, D + timedelta(days=1)), 3)
    assert rec.sent == [("Stretch", "start", "2026-10-13T16:00")], rec.sent


def test_snooze_fires_again_once():
    fresh_db()
    iid = reminders.add_item("Take a break", D.isoformat(), "15:00", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(14, 59).isoformat())
    tick(rec, at(14, 59), 2)
    reminders.snooze(iid, "2026-10-12T15:00", 10, now=at(15, 1))
    tick(rec, at(15, 1), 15)
    assert rec.sent == [("Take a break", "start", "2026-10-12T15:00"), ("Take a break", "snooze", "2026-10-12T15:00")], rec.sent


def test_sleep_gap_gives_one_summary_not_a_burst():
    fresh_db()
    reminders.add_item("DSA practice", D.isoformat(), "19:00")
    reminders.add_item("Gym", D.isoformat(), "20:00")
    reminders.add_item("Read", D.isoformat(), "21:55", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(18, 0).isoformat())
    run(rec, at(22, 0))  # laptop slept 18:00 -> 22:00
    assert rec.sent == [("Read", "start", "2026-10-12T21:55")], rec.sent  # 5 min late: still fires
    assert len(rec.summaries) == 1 and "DSA practice at 19:00" in rec.summaries[0] and "Gym at 20:00" in rec.summaries[0], rec.summaries
    run(rec, at(22, 0, D))
    assert len(rec.summaries) == 1, "summary repeated"


def test_restart_catches_up_from_last_check():
    fresh_db()
    reminders.add_item("Call home", D.isoformat(), "18:02", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(18, 0).isoformat())  # app closed at 18:00
    run(rec, at(18, 5))  # reopened at 18:05
    assert rec.sent == [("Call home", "start", "2026-10-12T18:02")], rec.sent


def test_clock_moved_back_neither_replays_nor_crashes():
    fresh_db()
    reminders.add_item("Water", D.isoformat(), "12:00", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(11, 59).isoformat())
    tick(rec, at(11, 59), 2)
    reminders.set_meta("last_check", at(12, 30).isoformat())
    run(rec, at(11, 30))  # clock jumped back an hour
    tick(rec, at(11, 59), 2)
    assert rec.sent == [("Water", "start", "2026-10-12T12:00")], rec.sent


def test_very_long_gap_only_looks_back_a_day():
    fresh_db()
    reminders.add_item("Old thing", D.isoformat(), "10:00", remind_before=None)
    rec = Recorder()
    reminders.set_meta("last_check", at(9, 0).isoformat())
    run(rec, at(12, 0, D + timedelta(days=3)))
    assert rec.sent == [] and rec.summaries == [], (rec.sent, rec.summaries)


def test_date_only_deadline_pings_at_nine():
    fresh_db()
    reminders.add_item("Assignment due", (D + timedelta(days=1)).isoformat())
    rec = Recorder()
    reminders.set_meta("last_check", at(8, 59, D + timedelta(days=1)).isoformat())
    tick(rec, at(8, 59, D + timedelta(days=1)), 2)
    assert rec.sent == [("Assignment due", "day", "2026-10-13T09:00")], rec.sent


def test_deleted_item_never_fires():
    fresh_db()
    iid = reminders.add_item("Cancelled", D.isoformat(), "13:00")
    reminders.delete_item(iid)
    rec = Recorder()
    reminders.set_meta("last_check", at(12, 30).isoformat())
    tick(rec, at(12, 30), 40)
    assert rec.sent == [], rec.sent


def test_llm_down_still_reminds_with_plain_words():
    fresh_db()
    reminders.add_item("Meds", D.isoformat(), "08:00", remind_before=None)
    texts = []

    async def capture(text, n, urgency):
        texts.append(text)

    async def summary(text, missed):
        pass

    LLM_REPLIES.extend([RuntimeError("All LLM providers failed")])
    reminders.set_meta("last_check", at(7, 59).isoformat())
    asyncio.run(scheduler.check(capture, summary, now=at(8, 0)))
    assert texts == ["Time for Meds — it starts now."], texts


def test_validation_rejects_bad_input():
    fresh_db()
    for bad in [("x", "2026-13-01", "10:00", None), ("x", D.isoformat(), "25:00", None), ("x", D.isoformat(), "10:00", "FREQ=MINUTELY"), ("", D.isoformat(), None, None)]:
        try:
            reminders.add_item(*bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted bad input {bad}")


def test_migrates_v1_tasks_table():
    path = TMP / "v1.db"
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, task_date TEXT, start_time TEXT, end_time TEXT, priority TEXT, done INTEGER, reminded_15 INTEGER, reminded_start INTEGER)")
        c.execute("INSERT INTO tasks VALUES (1, 'Old task', '2026-10-10', '9:05', NULL, 'high', 1, 1, 1)")
        c.execute("INSERT INTO tasks VALUES (2, 'Broken time', '2026-10-10', '4pm', NULL, 'normal', 0, 0, 0)")
    schedule_store.DB_PATH = path
    reminders.init_tables()
    reminders.init_tables()  # running twice must be harmless
    with schedule_store.get_conn() as c:
        rows = [dict(r) for r in c.execute("SELECT title, due_time, status FROM items ORDER BY id")]
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert rows == [{"title": "Old task", "due_time": "09:05", "status": "done"}, {"title": "Broken time", "due_time": None, "status": "open"}], rows
    assert "tasks" not in tables and "tasks_v1_migrated" in tables, tables


# ------------------------------------------------------ conversation actions

def say(text, reply):
    LLM_REPLIES.append(reply)
    return asyncio.run(conversation.converse(text))


def test_chat_add_in_minutes_and_repeat():
    fresh_db()
    r = say("remind me to take a break in 30 minutes", {"say": "Will do!", "mood": "happy", "action": {"type": "add", "title": "Take a break", "in_minutes": 30}})
    item = reminders.get_item(1)
    expected = (datetime.now() + timedelta(minutes=30)).strftime("%H:%M")
    assert r["applied"] and item["due_time"] in (expected, (datetime.now() + timedelta(minutes=31)).strftime("%H:%M")), (r, item)
    r = say("every night at 9 remind me to plan tomorrow", {"say": "Sure.", "mood": "happy", "action": {"type": "add", "title": "Plan tomorrow", "time": "21:00", "repeat": "FREQ=DAILY"}})
    assert r["applied"] and reminders.get_item(2)["rrule"] == "FREQ=DAILY", r


def test_chat_delete_needs_yes():
    fresh_db()
    reminders.add_item("Gym", date.today().isoformat(), "18:00")
    r = say("delete the gym reminder", {"say": "Deleted!", "mood": "neutral", "action": {"type": "delete", "id": 1}})
    assert not r["applied"] and "Say yes" in r["say"] and reminders.get_item(1), r
    r = say("yes please", "THE LLM MUST NOT BE CALLED")
    assert r["applied"] and reminders.get_item(1) is None and "Deleted" in r["say"], r
    assert LLM_REPLIES == ["THE LLM MUST NOT BE CALLED"], "a plain yes went to the LLM"


def test_chat_delete_no_keeps_it():
    fresh_db()
    reminders.add_item("Gym", date.today().isoformat(), "18:00")
    say("delete gym", {"say": "ok", "mood": "neutral", "action": {"type": "delete", "id": 1}})
    LLM_REPLIES.clear()
    r = say("no, keep it", "THE LLM MUST NOT BE CALLED")
    assert not r["applied"] and reminders.get_item(1) and "keep" in r["say"].lower(), r


def test_chat_snooze_this_uses_last_reminder():
    fresh_db()
    iid = reminders.add_item("Stretch", date.today().isoformat(), "10:00")
    reminders.record_fired(iid, f"{date.today().isoformat()}T10:00", "start")
    r = say("snooze this for ten minutes", {"say": "Okay.", "mood": "neutral", "action": {"type": "snooze", "id": None, "minutes": 10}})
    assert r["applied"], r
    with schedule_store.get_conn() as c:
        assert c.execute("SELECT COUNT(*) FROM snoozes").fetchone()[0] == 1


def test_chat_refuses_unknown_ids_and_bad_repeats():
    fresh_db()
    reminders.add_item("Gym", date.today().isoformat(), "18:00")
    r = say("done with the thing", {"say": "Done!", "mood": "happy", "action": {"type": "complete", "id": 999}})
    assert not r["applied"] and "which task" in r["say"], r
    r = say("every minute remind me", {"say": "Sure!", "mood": "happy", "action": {"type": "add", "title": "spam", "time": "10:00", "repeat": "FREQ=MINUTELY"}})
    assert not r["applied"] and "repeat" in r["say"], r


def test_complete_one_time_via_chat():
    fresh_db()
    reminders.add_item("Assignment", date.today().isoformat())
    r = say("I finished the assignment", {"say": "Great job!", "mood": "happy", "action": {"type": "complete", "id": 1}})
    assert r["applied"] and reminders.get_item(1)["status"] == "done", r


# ---------------------------------------------------------------------- runner

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
            traceback.print_exc(limit=3)
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
