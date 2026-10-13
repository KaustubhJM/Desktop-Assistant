"""
briefing.py

The morning hello (app/src/main/checkins.ts asks for it once a day, the
first time you're at the laptop after 6 AM): a few spoken sentences with
the weather, today's tasks, any special day (your birthday, a festival) and
a little encouragement or fun fact, plus today's list for the chat panel.

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
today's tasks (how many, and the first one or two with times), and end with one tiny encouragement or fun fact.
Under 45 words. No emoji, no markdown, no lists in SAY.

What you know about the user:
{facts}
Weather: {weather}
Today's tasks (time | title):
{tasks}

Reply in exactly this format:
SAY: <the hello>
DETAILS: <today's tasks as a markdown list "- HH:MM — title", or the word none>"""


def _task_lines(occ: list[dict]) -> list[str]:
    return [f"{o['time'] or 'any time'} | {o['title']}" for o in occ]


def _details(occ: list[dict]) -> Optional[str]:
    return "\n".join(f"- {o['time'] or 'any time'} — {o['title']}" for o in occ) or None


def template(name: str, occ: list[dict], special: Optional[dict]) -> dict:
    """The hello without any model: still useful."""
    parts = [special["label"] if special else "Good morning!"]
    if not occ:
        parts.append("Nothing on your list today.")
    elif len(occ) == 1:
        parts.append(f"You have one thing today: {occ[0]['title']}{' at ' + occ[0]['time'] if occ[0]['time'] else ''}.")
    else:
        first = occ[0]
        parts.append(f"You have {len(occ)} things today, starting with {first['title']}{' at ' + first['time'] if first['time'] else ''}.")
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
        tasks="\n".join(_task_lines(occ)) or "(nothing today)",
    )
    try:
        say, details = web.parse(await agent._call_llm(prompt))
    except RuntimeError:
        say, details = "", None
    if not say:
        return template(name, occ, special)
    return {"say": say, "details": details or _details(occ)}
