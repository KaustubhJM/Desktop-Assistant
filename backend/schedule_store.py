"""
schedule_store.py

Shared database plumbing: where the SQLite file lives, connections, and
time normalisation. The schedule itself lives in reminders.py (tasks,
repeats, completions, what's due) and the conversation in conversation.py.
"""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# REMINDER_DB_PATH lets tests point at a throwaway database.
DB_PATH = Path(os.getenv("REMINDER_DB_PATH") or Path(__file__).parent / "schedule.db")


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def normalize_time(value) -> str:
    """
    Turn a 24h time like "9:00" into the canonical zero-padded "09:00".

    Times are compared and sorted as plain strings, so every stored time must
    share this exact format. Anything unparseable (e.g. "4pm", "25:00")
    raises ValueError here, at the door, instead of breaking reminders later.
    """
    try:
        return datetime.strptime(str(value).strip(), "%H:%M").strftime("%H:%M")
    except ValueError:
        raise ValueError(f"invalid time {value!r} — expected 24-hour HH:MM, e.g. 16:00") from None
