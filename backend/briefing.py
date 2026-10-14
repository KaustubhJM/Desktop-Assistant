"""
briefing.py

The morning hello (app/src/main/checkins.ts asks for it once a day, the
first time you're at the laptop after 6 AM): a few spoken sentences with
the weather, how many tasks you have today (just the number: the model is
only told the count, so it can't read your tasks out), any special day (your
birthday, a festival) and a little encouragement or fun fact. Today's list
goes to the chat panel, shown but not spoken.

Two model calls at most, once a day: one web search for the weather (the
providers' built-in search, as in web.py) and one to write the hello. If
either fails, a plain hello from a template still works.
"""

from datetime import date
from typing import Optional

import agent
import memory
import occasions
import reminders
import web

PROMPT = """You are {name}, a cute, friendly desktop robot. Write the user's good-morning hello, spoken aloud.
Include, briefly: a greeting (use their name if you know it), {occasion}the weather in a few words if given,
how many tasks they have today (just the number, e.g. "you've got three things today"; never what they are),
and end with one tiny encouragement or fun fact. Under 45 words. No emoji, no markdown, no lists.

What you know about the user:
{facts}
Weather: {weather}
Number of tasks today: {count}

Reply in exactly this format:
SAY: <the hello>"""

NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def _count_words(n: int) -> str:
    """"You have three things today": the spoken count (the template's wording)."""
    if n == 0:
        return "Nothing on your list today."
    word = NUMBERS[n] if n < len(NUMBERS) else str(n)
    return f"You have {word} thing{'' if n == 1 else 's'} today."


def _details(occ: list[dict]) -> Optional[str]:
    return "\n".join(f"- {o['time'] or 'any time'} — {o['title']}" for o in occ) or None


def template(name: str, occ: list[dict], special: Optional[dict]) -> dict:
    """The hello without any model: still useful."""
    parts = [special["label"] if special else "Good morning!", _count_words(len(occ))]
    return {"say": " ".join(parts), "details": _details(occ)}


async def morning(name: str = "Bit") -> dict:
    today = date.today()
    occ = [o for o in reminders.occurrences(today, today) if not o["done"]]
    occ.sort(key=lambda o: o["time"] or "99")
    special = occasions.today(today)
    ok, weather, _ = await web.answer("weather today", "What's the weather like today where I am?")
    prompt = PROMPT.format(
        name=name,
        occasion=f"today's special day ({special['label']}), " if special else "",
        facts=memory.facts_for_prompt("morning"),
        weather=weather if ok else "(unknown)",
        count=len(occ),
    )
    try:
        say, _ = web.parse(await agent._call_llm(prompt))
    except RuntimeError:
        say = ""
    if not say:
        return template(name, occ, special)
    return {"say": say, "details": _details(occ)}  # the list: in the panel, not spoken
