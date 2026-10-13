"""
occasions.py

Special days, for a little badge beside the robot (a diya at Diwali, a cake
on your birthday) and for the morning hello. Festivals with moving dates
(Diwali, Holi...) are listed per year; your birthday comes from what Bit
remembers about you (memory.py), if you've told it.
"""

import re
from datetime import date
from typing import Optional

from dateutil import parser as dateparser

import memory

# (month, day) ranges, inclusive. Fixed-date ones every year:
FIXED = [
    ((1, 1), (1, 1), "🎆", "Happy New Year!"),
    ((1, 26), (1, 26), "🪁", "Happy Republic Day!"),
    ((2, 14), (2, 14), "💝", "Happy Valentine's Day!"),
    ((8, 15), (8, 15), "🪁", "Happy Independence Day!"),
    ((10, 31), (10, 31), "🎃", "Happy Halloween!"),
    ((12, 24), (12, 26), "🎄", "Merry Christmas!"),
    ((12, 31), (12, 31), "🎆", "Happy New Year's Eve!"),
]
# Moving dates: year -> [(first day, last day, emoji, greeting)]
MOVING = {
    2026: [(date(2026, 3, 3), date(2026, 3, 4), "🎨", "Happy Holi!"), (date(2026, 11, 7), date(2026, 11, 9), "🪔", "Happy Diwali!")],
    2027: [(date(2027, 3, 21), date(2027, 3, 22), "🎨", "Happy Holi!"), (date(2027, 10, 27), date(2027, 10, 29), "🪔", "Happy Diwali!")],
    2028: [(date(2028, 3, 10), date(2028, 3, 11), "🎨", "Happy Holi!"), (date(2028, 10, 16), date(2028, 10, 18), "🪔", "Happy Diwali!")],
}


def birthday() -> Optional[date]:
    """The user's birthday (this year), if Bit remembers it."""
    for f in memory.facts():
        if "birthday" in f["key"] or "birthday" in f["fact"].lower() or "born" in f["fact"].lower():
            text = re.sub(r"\b(19|20)\d{2}\b", "", f["fact"])  # the year isn't needed (and confuses "on 15 March 2005")
            try:
                d = dateparser.parse(text, fuzzy=True, default=date.today().replace(day=1))
            except (ValueError, OverflowError):
                continue
            if d and re.search(r"\d", text):
                return date(date.today().year, d.month, d.day)
    return None


def today(on: Optional[date] = None) -> Optional[dict]:
    """{"emoji", "label"} for a special day, else None. Your birthday wins."""
    d = on or date.today()
    b = birthday()
    if b and (b.month, b.day) == (d.month, d.day):
        return {"emoji": "🎂", "label": "Happy birthday!", "birthday": True}
    for first, last, emoji, label in MOVING.get(d.year, []):
        if first <= d <= last:
            return {"emoji": emoji, "label": label}
    for (m1, d1), (m2, d2), emoji, label in FIXED:
        if (m1, d1) <= (d.month, d.day) <= (m2, d2):
            return {"emoji": emoji, "label": label}
    return None
