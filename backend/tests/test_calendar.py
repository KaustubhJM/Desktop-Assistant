"""
Tests for gcal.py (Google Calendar) with a fake calendar: reading events,
reminders for them (exactly once, never late), the AI seeing them, adding
events, and behaving when not connected. No Google account needed.

Run:  venv\\Scripts\\python tests\\test_calendar.py
"""

import asyncio
import json
import os
import sys
import tempfile
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
TMP = Path(tempfile.mkdtemp(prefix="calendar-tests-"))
os.environ["REMINDER_DB_PATH"] = str(TMP / "cal.db")

import agent  # noqa: E402
import conversation  # noqa: E402
import gcal  # noqa: E402
import reminders  # noqa: E402
import scheduler  # noqa: E402

gcal.TOKEN = TMP / "no-token.json"  # never the real one
reminders.init_tables()
conversation.init_tables()
gcal.init_tables()


def iso(dt: datetime) -> str:
    return dt.astimezone().isoformat()


class FakeCalendar:
    def __init__(self, events):
        self.events = events
        self.inserted = []
        self.lists = 0

    def list(self, start, end):
        self.lists += 1
        return self.events

    def insert(self, body):
        self.inserted.append(body)
        return {"id": "new1", "summary": body["summary"], "start": body["start"], "end": body["end"]}


def use(events):
    cal = FakeCalendar(events)
    gcal.client = cal
    gcal._cache.update(at=0, key=None, events=[])
    return cal


NOW = datetime.now().replace(second=0, microsecond=0)
STANDUP = {"id": "e1", "summary": "Team standup", "location": "Zoom",
           "start": {"dateTime": iso(NOW + timedelta(hours=1))}, "end": {"dateTime": iso(NOW + timedelta(hours=1, minutes=30))}}
HOLIDAY = {"id": "e2", "summary": "Diwali holiday", "start": {"date": (date.today() + timedelta(days=2)).isoformat()},
           "end": {"date": (date.today() + timedelta(days=3)).isoformat()}}
CANCELLED = {"id": "e3", "summary": "Old meeting", "status": "cancelled", "start": {"dateTime": iso(NOW + timedelta(hours=2))}}


def test_reads_events():
    use([STANDUP, HOLIDAY, CANCELLED])
    ev = gcal.upcoming(7)
    assert [e["title"] for e in ev] == ["Team standup", "Diwali holiday"], ev
    assert not ev[0]["all_day"] and ev[0]["start"] == NOW + timedelta(hours=1) and ev[0]["location"] == "Zoom"
    assert ev[1]["all_day"]


def test_events_are_cached_briefly():
    cal = use([STANDUP])
    gcal.upcoming(7)
    gcal.upcoming(7)
    assert cal.lists == 1, cal.lists


def test_reminders_once_each_and_never_late():
    use([STANDUP])
    start = NOW + timedelta(hours=1)
    warn = start - timedelta(minutes=15)
    assert gcal.due(warn - timedelta(seconds=20), warn) and gcal.due(warn - timedelta(seconds=20), warn) == [], "warn once"
    got = gcal.due(start - timedelta(seconds=20), start)
    assert [(e["title"], e["kind"]) for e in got] == [("Team standup", "start")], got
    # Asleep through the start: 40 minutes late is skipped, not fired late.
    use([dict(STANDUP, id="e9")])
    assert gcal.due(start - timedelta(hours=1), start + timedelta(minutes=40)) == []


def test_all_day_events_dont_ping():
    use([HOLIDAY])
    d = datetime.combine(date.today() + timedelta(days=2), datetime.min.time())
    assert gcal.due(d - timedelta(hours=1), d + timedelta(minutes=1)) == []


def test_scheduler_sends_calendar_reminders():
    use([dict(STANDUP, id="e5")])
    sent = []

    async def on_reminder(text, n, urgency):
        sent.append((text, n["kind"], n["item_id"], urgency))

    async def on_summary(text, missed):
        pass
    start = NOW + timedelta(hours=1)
    reminders.set_meta("last_check", (start - timedelta(seconds=20)).isoformat())
    asyncio.run(scheduler.check(on_reminder, on_summary, now=start))
    assert sent == [("It's time: Team standup at Zoom.", "calendar-start", None, "high")], sent


def test_the_ai_sees_the_calendar_and_can_add():
    cal = use([STANDUP])
    prompts = []

    async def capture(prompt):
        prompts.append(prompt)
        return json.dumps({"say": "Done!", "mood": "happy", "action": {"type": "calendar_add", "title": "Dentist", "date": (date.today() + timedelta(days=3)).isoformat(), "time": "16:00", "minutes": 45}})
    agent._call_llm = capture
    r = asyncio.run(conversation.converse("put dentist on my calendar in 3 days at 4pm"))
    assert any("Google Calendar, next 7 days" in p and "Team standup | Zoom" in p for p in prompts), prompts[0][:300]
    assert r["calendar_changed"] and r["say"].startswith('Added "Dentist" to your calendar'), r
    body = cal.inserted[0]
    start = datetime.fromisoformat(body["start"]["dateTime"])
    end = datetime.fromisoformat(body["end"]["dateTime"])
    assert body["summary"] == "Dentist" and start.hour == 16 and (end - start) == timedelta(minutes=45) and start.tzinfo is not None, body


def test_not_connected_says_so():
    gcal.client = None
    prompts = []

    async def capture(prompt):
        prompts.append(prompt)
        return json.dumps({"say": "Added!", "mood": "happy", "action": {"type": "calendar_add", "title": "Dentist", "date": date.today().isoformat(), "time": "16:00"}})
    agent._call_llm = capture
    r = asyncio.run(conversation.converse("put dentist on my calendar"))
    assert "isn't connected" in r["say"] and not any("Google Calendar, next 7 days" in p for p in prompts), r
    assert gcal.upcoming(7) == [] and gcal.due(NOW, NOW + timedelta(hours=3)) == []
    assert gcal.status()["connected"] is False


def test_connect_without_setup_explains():
    gcal.client = None
    real = gcal.CLIENT_SECRET
    gcal.CLIENT_SECRET = TMP / "missing.json"
    try:
        s = gcal.connect()
        assert not s["connected"] and "client_secret.json" in (s["error"] or "") and not s["set_up"], s
    finally:
        gcal.CLIENT_SECRET = real


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
