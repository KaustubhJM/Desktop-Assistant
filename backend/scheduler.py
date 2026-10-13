"""
scheduler.py

The heartbeat. Every 20 seconds (and right after the laptop wakes up) it asks
reminders.py "what became due since I last checked?" and sends those
notifications. It never depends on the LLM: the LLM only phrases the
reminder, and a plain sentence is used if it's slow or down.

Because it looks at everything due *since the last check* (remembered in the
database), nothing is lost to sleep, shutdown or a skipped tick:
  - due within the last LATE_OK_MINUTES: fires normally (a little late)
  - older than that: collected into ONE "while you were away" summary,
    instead of a burst of stale reminders
  - more than MAX_CATCHUP_HOURS ago: not mentioned at all
Every notification is claimed in the `fired` table before it's sent, so it
goes out exactly once, even if two checks overlap.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Awaitable, Callable, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler

import gcal
import reminders
from agent import decide_reminder_text

logger = logging.getLogger(__name__)

CHECK_EVERY_S = 20
LATE_OK_MINUTES = 10
MAX_CATCHUP_HOURS = 24
LLM_PHRASING_TIMEOUT_S = 8

OnReminder = Callable[[str, dict, str], Awaitable[None]]
OnSummary = Callable[[str, list], Awaitable[None]]


def _fallback_text(n: dict) -> str:
    title = n["title"]
    if n["kind"] == "warn":
        return f"{title} starts in {n.get('remind_before') or 15} minutes, at {n['time']}."
    if n["kind"] == "start":
        return f"Time for {title} — it starts now."
    if n["kind"] == "day":
        return f"Today: {title}."
    return f"Reminder again: {title}."


async def _phrase(n: dict) -> str:
    """LLM wording with a hard time limit; plain wording if it's slow or failing."""
    context = {
        "kind": n["kind"],
        "minutes_until_start": (n.get("remind_before") or 15) if n["kind"] == "warn" else 0,
        "is_15_min_warning": n["kind"] == "warn",
        "snoozed": n["kind"].startswith("snooze"),
        "date_only": n["kind"] == "day",
    }
    task = {"title": n["title"], "start_time": n.get("time") or "today", "priority": n.get("priority", "normal")}
    try:
        text = await asyncio.wait_for(decide_reminder_text(task, context), LLM_PHRASING_TIMEOUT_S)
        return text.strip() or _fallback_text(n)
    except Exception:
        logger.warning("LLM phrasing failed for %s; using plain text", n["title"], exc_info=True)
        return _fallback_text(n)


def summary_text(missed: list[dict]) -> str:
    names = []
    for n in missed:
        when = f" at {n['time']}" if n.get("time") else ""
        names.append(f"{n['title']}{when}")
    if len(names) == 1:
        return f"While you were away, you missed: {names[0]}."
    return f"While you were away, you missed {len(names)} reminders: {', '.join(names[:-1])} and {names[-1]}."


async def check(on_reminder: OnReminder, on_summary: OnSummary, now: Optional[datetime] = None) -> dict:
    """One pass. Returns what it did (used by tests)."""
    now = (now or datetime.now()).replace(microsecond=0)
    last_raw = reminders.get_meta("last_check")
    last = datetime.fromisoformat(last_raw) if last_raw else now - timedelta(seconds=CHECK_EVERY_S)
    if last > now:  # the clock was moved back: don't replay or skip, just restart from now
        last = now - timedelta(seconds=CHECK_EVERY_S)
    since = max(last, now - timedelta(hours=MAX_CATCHUP_HOURS))

    due = reminders.due_notifications(since, now)
    fresh = [n for n in due if n["late_minutes"] <= LATE_OK_MINUTES]
    stale = [n for n in due if n["late_minutes"] > LATE_OK_MINUTES]

    sent = []
    for n in fresh:
        if not reminders.record_fired(n["item_id"], n["occurrence"], n["kind"]):
            continue  # another check already sent it
        urgency = "high" if n["kind"] in ("start",) or n["kind"].startswith("snooze") else "normal"
        text = await _phrase(n)
        try:
            await on_reminder(text, n, urgency)
        except Exception:
            logger.exception("could not deliver reminder for %s", n["title"])
        sent.append((n["title"], n["kind"]))

    missed = []
    seen_occ = set()
    for n in stale:
        if not reminders.record_fired(n["item_id"], n["occurrence"], n["kind"], missed=True):
            continue
        key = (n["item_id"], n["occurrence"])
        if key not in seen_occ:  # one line per missed occurrence, not per warning
            seen_occ.add(key)
            missed.append(n)
    if missed:
        try:
            await on_summary(summary_text(missed), missed)
        except Exception:
            logger.exception("could not deliver the missed-reminders summary")

    # Google Calendar events (if connected): 15 minutes before and at the start, once each.
    for e in gcal.due(since, now, LATE_OK_MINUTES):
        n = {"item_id": None, "occurrence": e["start"].isoformat(), "kind": f"calendar-{e['kind']}", "title": e["title"]}
        try:
            await on_reminder(gcal.reminder_text(e), n, "high" if e["kind"] == "start" else "normal")
        except Exception:
            logger.exception("could not deliver calendar reminder for %s", e["title"])
        sent.append((e["title"], n["kind"]))

    reminders.set_meta("last_check", now.isoformat())
    return {"sent": sent, "missed": [(n["title"], n["kind"]) for n in missed], "since": since.isoformat()}


def create_scheduler(on_reminder: OnReminder, on_summary: OnSummary) -> tuple[AsyncIOScheduler, Callable[[], Awaitable[dict]]]:
    """Returns the scheduler and a check_now() coroutine (for wake-from-sleep)."""
    scheduler = AsyncIOScheduler()
    lock = asyncio.Lock()

    async def check_now() -> dict:
        async with lock:
            result = await check(on_reminder, on_summary)
            if datetime.now().minute == 0:
                reminders.prune()
            return result

    scheduler.add_job(check_now, "interval", seconds=CHECK_EVERY_S, id="check", max_instances=1, coalesce=True)
    return scheduler, check_now
