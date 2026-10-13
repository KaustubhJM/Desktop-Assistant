"""
reminders.py

Tasks and reminders — the ground truth of your schedule. Nothing here calls
the LLM; the scheduler and the conversation only read and write through
these functions, which validate everything.

Model
  items        one row per task/reminder: title, date, optional time,
               optional repeat rule (RFC 5545 RRULE, e.g. "FREQ=DAILY",
               the same format Google Calendar uses), how many minutes
               before to warn, status.
  completions  done-state per occurrence of a repeating item (ticking off
               today's "plan tomorrow" doesn't tick off tomorrow's).
  snoozes      "remind me again at …" for one occurrence.
  fired        every notification that has gone out, keyed by
               (item, occurrence, kind) — a PRIMARY KEY, so the same
               notification can never fire twice, even if two checks race.
  meta         small key/value state (when the scheduler last checked).

All times are local wall-clock time ("19:00 every day" stays 19:00).
"""

from datetime import date, datetime, time, timedelta
from typing import Optional

from dateutil.rrule import rrulestr

from schedule_store import get_conn, normalize_time

DEFAULT_WARN_MINUTES = 15
DAY_REMINDER_TIME = time(9, 0)  # date-only items ("assignment due Friday") ping at 9:00 that day
ALLOWED_FREQ = {"DAILY", "WEEKLY", "MONTHLY", "YEARLY"}


# -------------------------------------------------------------------- schema

def init_tables() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                notes TEXT,
                due_date TEXT NOT NULL,           -- YYYY-MM-DD (first date, for repeating items)
                due_time TEXT,                    -- HH:MM, or NULL for a date-only task/deadline
                rrule TEXT,                       -- e.g. FREQ=WEEKLY;BYDAY=MO,WE ; NULL = once
                remind_before INTEGER,            -- minutes before to warn; NULL = no early warning
                priority TEXT NOT NULL DEFAULT 'normal',
                status TEXT NOT NULL DEFAULT 'open',  -- open | done (one-time items)
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS completions (
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                occ_date TEXT NOT NULL,
                done_at TEXT NOT NULL,
                PRIMARY KEY (item_id, occ_date)
            );
            CREATE TABLE IF NOT EXISTS snoozes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                occurrence TEXT NOT NULL,         -- YYYY-MM-DDTHH:MM
                until TEXT NOT NULL               -- YYYY-MM-DDTHH:MM:SS
            );
            CREATE TABLE IF NOT EXISTS fired (
                item_id INTEGER NOT NULL,
                occurrence TEXT NOT NULL,
                kind TEXT NOT NULL,               -- warn | start | day | snooze:<id>
                fired_at TEXT NOT NULL,
                missed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (item_id, occurrence, kind)
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            """
        )
        conn.commit()
    _migrate_v1()


def _migrate_v1() -> None:
    """Move tasks from the original `tasks` table (if any) into `items`, once."""
    with get_conn() as conn:
        has_old = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").fetchone()
        if not has_old:
            return
        now = _now_str()
        rows = conn.execute("SELECT * FROM tasks").fetchall()
        for r in rows:
            try:
                due_time = normalize_time(r["start_time"])
            except ValueError:
                due_time = None
            conn.execute(
                "INSERT INTO items (title, due_date, due_time, remind_before, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (r["title"], r["task_date"], due_time, DEFAULT_WARN_MINUTES if due_time else None, r["priority"] or "normal", "done" if r["done"] else "open", now, now),
            )
        conn.execute("ALTER TABLE tasks RENAME TO tasks_v1_migrated")
        conn.commit()


# ---------------------------------------------------------------- validation

def normalize_date(value) -> str:
    """'2026-10-11', 'today', 'tomorrow' -> 'YYYY-MM-DD'. Raises ValueError otherwise."""
    if isinstance(value, date):
        return value.isoformat()
    s = str(value).strip().lower()
    if s == "today":
        return date.today().isoformat()
    if s == "tomorrow":
        return (date.today() + timedelta(days=1)).isoformat()
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        raise ValueError(f"invalid date {value!r} — expected YYYY-MM-DD") from None


def normalize_rrule(value) -> Optional[str]:
    """Validate a repeat rule. None/''/'none' = no repeat. Raises ValueError for anything unusable."""
    if value in (None, "", "none", "None", "null"):
        return None
    s = str(value).strip()
    if s.upper().startswith("RRULE:"):
        s = s[6:]
    parts = dict(p.split("=", 1) for p in s.upper().split(";") if "=" in p)
    if parts.get("FREQ") not in ALLOWED_FREQ:
        raise ValueError(f"unsupported repeat {value!r} — use daily, weekly, monthly or yearly")
    try:
        rrulestr(f"RRULE:{s.upper()}", dtstart=datetime(2026, 1, 1, 9, 0))
    except (ValueError, TypeError) as err:
        raise ValueError(f"invalid repeat rule {value!r} ({err})") from None
    return s.upper()


# ----------------------------------------------------------------------- crud

def _now_str() -> str:
    return datetime.now().isoformat(timespec="seconds")


def add_item(title: str, due_date, due_time=None, rrule=None, remind_before: Optional[int] = -1,
             notes: Optional[str] = None, priority: str = "normal") -> int:
    title = (title or "").strip()
    if not title:
        raise ValueError("a task needs a title")
    d = normalize_date(due_date)
    t = normalize_time(due_time) if due_time not in (None, "") else None
    r = normalize_rrule(rrule)
    if remind_before == -1:  # default: warn 15 min ahead for timed items
        remind_before = DEFAULT_WARN_MINUTES if t else None
    now = _now_str()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO items (title, notes, due_date, due_time, rrule, remind_before, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (title[:200], notes, d, t, r, remind_before, priority or "normal", now, now),
        )
        conn.commit()
        return cur.lastrowid


def update_item(item_id: int, **fields) -> bool:
    allowed = {"title", "notes", "due_date", "due_time", "rrule", "remind_before", "priority", "status"}
    clean = {}
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "due_date":
            v = normalize_date(v)
        elif k == "due_time":
            v = normalize_time(v) if v not in (None, "") else None
        elif k == "rrule":
            v = normalize_rrule(v)
        elif k == "title":
            v = (v or "").strip()[:200]
            if not v:
                raise ValueError("a task needs a title")
        elif k == "status" and v not in ("open", "done"):
            raise ValueError("status must be open or done")
        clean[k] = v
    if not clean:
        return False
    clean["updated_at"] = _now_str()
    cols = ", ".join(f"{k} = ?" for k in clean)
    with get_conn() as conn:
        cur = conn.execute(f"UPDATE items SET {cols} WHERE id = ?", [*clean.values(), item_id])
        conn.commit()
        return cur.rowcount > 0


def delete_item(item_id: int) -> bool:
    with get_conn() as conn:
        conn.execute("DELETE FROM completions WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM snoozes WHERE item_id = ?", (item_id,))
        cur = conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.commit()
        return cur.rowcount > 0


def get_item(item_id: int) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return dict(row) if row else None


# --------------------------------------------------------------- occurrences

def _item_dates(item: dict, start: date, end: date) -> list[date]:
    """Dates (within start..end) on which this item happens."""
    first = date.fromisoformat(item["due_date"])
    if not item["rrule"]:
        return [first] if start <= first <= end else []
    t = time.fromisoformat(item["due_time"]) if item["due_time"] else DAY_REMINDER_TIME
    rule = rrulestr(f"RRULE:{item['rrule']}", dtstart=datetime.combine(first, t))
    lo = datetime.combine(max(start, first), time.min)
    hi = datetime.combine(end, time.max)
    return [dt.date() for dt in rule.between(lo, hi, inc=True)]


def occurrences(start: date, end: date) -> list[dict]:
    """Every occurrence of every item between two dates (inclusive), with done-state, in time order."""
    with get_conn() as conn:
        items = [dict(r) for r in conn.execute("SELECT * FROM items")]
        done_pairs = {(r["item_id"], r["occ_date"]) for r in conn.execute("SELECT item_id, occ_date FROM completions")}
    out = []
    for it in items:
        for d in _item_dates(it, start, end):
            done = it["status"] == "done" if not it["rrule"] else (it["id"], d.isoformat()) in done_pairs
            out.append({
                "item_id": it["id"],
                "title": it["title"],
                "notes": it["notes"],
                "date": d.isoformat(),
                "time": it["due_time"],
                "repeat": it["rrule"],
                "remind_before": it["remind_before"],
                "priority": it["priority"],
                "done": done,
                "occurrence": f"{d.isoformat()}T{it['due_time'] or DAY_REMINDER_TIME.strftime('%H:%M')}",
                "repeat_text": describe_repeat(it["rrule"]),
            })
    out.sort(key=lambda o: (o["date"], o["time"] or "", o["title"]))
    return out


def today() -> list[dict]:
    d = date.today()
    return occurrences(d, d)


def complete(item_id: int, occ_date: Optional[str] = None, done: bool = True) -> bool:
    """Mark done (or not). One-time items: the item; repeating items: that day's occurrence (default today)."""
    item = get_item(item_id)
    if not item:
        return False
    if not item["rrule"]:
        return update_item(item_id, status="done" if done else "open")
    d = normalize_date(occ_date or date.today().isoformat())
    with get_conn() as conn:
        if done:
            conn.execute("INSERT OR IGNORE INTO completions (item_id, occ_date, done_at) VALUES (?, ?, ?)", (item_id, d, _now_str()))
        else:
            conn.execute("DELETE FROM completions WHERE item_id = ? AND occ_date = ?", (item_id, d))
        conn.commit()
    return True


def snooze(item_id: int, occurrence: str, minutes: int, now: Optional[datetime] = None) -> str:
    if not get_item(item_id):
        raise ValueError("no such task")
    minutes = max(1, min(int(minutes), 24 * 60))
    until = ((now or datetime.now()) + timedelta(minutes=minutes)).replace(microsecond=0)
    with get_conn() as conn:
        conn.execute("INSERT INTO snoozes (item_id, occurrence, until) VALUES (?, ?, ?)", (item_id, occurrence, until.isoformat()))
        conn.commit()
    return until.strftime("%H:%M")


def last_fired() -> Optional[dict]:
    """The most recent reminder that went out (what "snooze this" refers to)."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM fired WHERE kind NOT LIKE 'missed%' ORDER BY fired_at DESC LIMIT 1").fetchone()
        return dict(row) if row else None


# ------------------------------------------------------- what's due (scheduler)

def due_notifications(since: datetime, now: datetime) -> list[dict]:
    """
    Notifications whose time falls in (since, now], not yet fired, for items
    not done. Each: {item_id, title, occurrence, kind, at, late_minutes}.
    """
    out = []
    for o in occurrences(since.date() - timedelta(days=1), now.date() + timedelta(days=1)):
        if o["done"]:
            continue
        occ_dt = datetime.fromisoformat(o["occurrence"])
        if o["time"]:
            moments = [("start", occ_dt)]
            if o["remind_before"]:
                moments.append(("warn", occ_dt - timedelta(minutes=o["remind_before"])))
        else:
            moments = [("day", occ_dt)]
        for kind, at in moments:
            if since < at <= now:
                out.append({**o, "kind": kind, "at": at, "late_minutes": (now - at).total_seconds() / 60})
    with get_conn() as conn:
        for s in conn.execute("SELECT * FROM snoozes"):
            at = datetime.fromisoformat(s["until"])
            item = get_item(s["item_id"])
            if item and since < at <= now:
                out.append({
                    "item_id": s["item_id"], "title": item["title"], "occurrence": s["occurrence"],
                    "time": item["due_time"], "kind": f"snooze:{s['id']}", "at": at,
                    "late_minutes": (now - at).total_seconds() / 60, "done": False,
                })
    already = _fired_keys()
    out = [n for n in out if (n["item_id"], n["occurrence"], n["kind"]) not in already]
    # If an occurrence's start is due too, its early warning is redundant.
    starts = {(n["item_id"], n["occurrence"]) for n in out if n["kind"] == "start"}
    out = [n for n in out if not (n["kind"] == "warn" and (n["item_id"], n["occurrence"]) in starts)]
    out.sort(key=lambda n: n["at"])
    return out


def _fired_keys() -> set:
    with get_conn() as conn:
        return {(r["item_id"], r["occurrence"], r["kind"]) for r in conn.execute("SELECT item_id, occurrence, kind FROM fired")}


def record_fired(item_id: int, occurrence: str, kind: str, missed: bool = False) -> bool:
    """Claim a notification. True only for the first caller — duplicates are impossible."""
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO fired (item_id, occurrence, kind, fired_at, missed) VALUES (?, ?, ?, ?, ?)",
            (item_id, occurrence, kind, _now_str(), int(missed)),
        )
        conn.commit()
        return cur.rowcount == 1


def get_meta(key: str) -> Optional[str]:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_meta(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
        conn.commit()


def describe_repeat(rule: Optional[str]) -> str:
    """Human words for a repeat rule (for replies and the panel)."""
    if not rule:
        return "once"
    parts = dict(p.split("=", 1) for p in rule.split(";") if "=" in p)
    freq, interval = parts.get("FREQ"), int(parts.get("INTERVAL", "1"))
    days = {"MO": "Mon", "TU": "Tue", "WE": "Wed", "TH": "Thu", "FR": "Fri", "SA": "Sat", "SU": "Sun"}
    if freq == "DAILY":
        return "every day" if interval == 1 else f"every {interval} days"
    if freq == "WEEKLY":
        by = parts.get("BYDAY")
        if by == "MO,TU,WE,TH,FR":
            return "every weekday"
        names = ", ".join(days.get(d, d) for d in by.split(",")) if by else ""
        base = "every week" if interval == 1 else f"every {interval} weeks"
        return f"{base} on {names}" if names else base
    if freq == "MONTHLY":
        return "every month" if interval == 1 else f"every {interval} months"
    return "every year"


def prune(now: Optional[datetime] = None) -> None:
    """Forget fired notifications and snoozes older than the scheduler can ever look back."""
    cutoff = ((now or datetime.now()) - timedelta(days=3)).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute("DELETE FROM fired WHERE fired_at < ?", (cutoff,))
        conn.execute("DELETE FROM snoozes WHERE until < ?", (cutoff,))
        conn.commit()
