"""
actions.py

Schedule changes the LLM may ask for, applied only after validation. The
LLM's output is untrusted: anything missing, unparseable, or pointing at a
task it wasn't shown is refused with a friendly message instead of a crash
or a wrong edit. Deleting needs an explicit "yes" from you first.

Action shapes (from conversation.py's prompt):
  {"type": "add", "title", "date"?, "time"?, "in_minutes"?, "repeat"?, "notes"?}
  {"type": "update", "id", "title"?, "date"?, "time"?, "repeat"?}
  {"type": "complete", "id", "date"?}
  {"type": "snooze", "id"?, "minutes"}          (no id = the reminder that just went off)
  {"type": "delete", "id"}                       (asks for confirmation)
  {"type": "confirm"} / {"type": "cancel"}       (answer to a pending confirmation)
"""

from datetime import date, datetime, timedelta
from typing import Optional

import reminders

CONFIRM_TTL = timedelta(minutes=3)

# A destructive action waiting for "yes". Single user, so one slot is enough.
_pending: Optional[dict] = None


def pending_confirmation() -> Optional[dict]:
    global _pending
    if _pending and datetime.now() - _pending["asked_at"] > CONFIRM_TTL:
        _pending = None
    return _pending


def _item_id(action: dict, visible_ids: set[int]) -> Optional[int]:
    """The id the LLM picked — only if it's an item it was actually shown."""
    try:
        item_id = int(action.get("id", action.get("task_id")))
    except (TypeError, ValueError):
        return None
    return item_id if item_id in visible_ids else None


def _when_words(d: str, t: Optional[str]) -> str:
    day = date.fromisoformat(d)
    today = date.today()
    label = "today" if day == today else "tomorrow" if day == today + timedelta(days=1) else day.strftime("%A %d %B")
    return f"{label} at {t}" if t else label


def apply_action(action: Optional[dict], visible_ids: set[int]) -> tuple[bool, Optional[str]]:
    """
    Returns (applied, message):
      (True, confirmation)  something changed
      (False, explanation)  refused, or waiting for your confirmation
      (False, None)         no action
    """
    global _pending
    if not isinstance(action, dict):
        return False, None
    kind = action.get("type") or action.get("action")
    if kind in (None, "none"):
        return False, None

    try:
        if kind == "add":
            title = str(action.get("title") or "").strip()
            if not title:
                return False, "I couldn't tell what to add — could you say it again with a name and a time?"
            when_date, when_time = action.get("date"), action.get("time")
            if action.get("in_minutes") not in (None, ""):
                at = datetime.now() + timedelta(minutes=max(1, int(action["in_minutes"])))
                when_date, when_time = at.date().isoformat(), at.strftime("%H:%M")
            if not when_date:
                when_date = date.today().isoformat()
            item_id = reminders.add_item(title, when_date, when_time, action.get("repeat"), notes=action.get("notes"))
            item = reminders.get_item(item_id)
            repeat = f", {reminders.describe_repeat(item['rrule'])}" if item["rrule"] else ""
            return True, f"Added \"{item['title']}\" — {_when_words(item['due_date'], item['due_time'])}{repeat}."

        if kind == "confirm":
            pending = pending_confirmation()
            if not pending:
                return False, None
            _pending = None
            if reminders.delete_item(pending["id"]):
                return True, f"Deleted \"{pending['title']}\"."
            return False, "That task was already gone."

        if kind == "cancel":
            if pending_confirmation():
                _pending = None
                return False, "Okay, I'll keep it."
            return False, None

        if kind == "snooze":
            minutes = int(action.get("minutes") or 10)
            target_id = _item_id(action, visible_ids)
            last = reminders.last_fired()
            if target_id is None and last:
                target_id, occurrence = last["item_id"], last["occurrence"]
            elif target_id is not None:
                item = reminders.get_item(target_id)
                occurrence = f"{date.today().isoformat()}T{item['due_time'] or '09:00'}"
            else:
                return False, "There's no reminder to snooze right now."
            until = reminders.snooze(target_id, occurrence, minutes)
            item = reminders.get_item(target_id)
            return True, f"Snoozed \"{item['title']}\" — I'll remind you again at {until}."

        item_id = _item_id(action, visible_ids)
        if item_id is None:
            return False, "I couldn't tell which task you meant — could you name it?"
        item = reminders.get_item(item_id)

        if kind == "update":
            fields = {}
            if action.get("title"):
                fields["title"] = action["title"]
            if action.get("date"):
                fields["due_date"] = action["date"]
            if "time" in action and action["time"] is not None:
                fields["due_time"] = action["time"]
            if "repeat" in action:
                fields["rrule"] = action["repeat"]
            if not fields:
                return False, "What should I change about it?"
            reminders.update_item(item_id, **fields)
            item = reminders.get_item(item_id)
            repeat = f", {reminders.describe_repeat(item['rrule'])}" if item["rrule"] else ""
            return True, f"Updated \"{item['title']}\" — {_when_words(item['due_date'], item['due_time'])}{repeat}."

        if kind in ("complete", "done"):
            reminders.complete(item_id, action.get("date"))
            return True, f"Marked \"{item['title']}\" as done. Nice!"

        if kind == "delete":
            _pending = {"type": "delete", "id": item_id, "title": item["title"], "asked_at": datetime.now()}
            return False, f"Delete \"{item['title']}\"{' and all its repeats' if item['rrule'] else ''}? Say yes to confirm."

    except ValueError as err:
        msg = str(err)
        if "time" in msg:
            return False, "I couldn't work out the time — try something like \"at 16:00\" or \"at 4 PM\"."
        if "date" in msg:
            return False, "I couldn't work out the date — could you say it another way?"
        if "repeat" in msg:
            return False, "I can repeat daily, on certain weekdays, weekly, monthly or yearly — which did you mean?"
        return False, "Something about that didn't make sense to me — could you rephrase?"

    return False, None
