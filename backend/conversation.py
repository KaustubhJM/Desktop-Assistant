"""
conversation.py

The robot's side of a conversation: personality, and turning one user
message into a reply.

Memory lives in memory.py (LangGraph): separate conversation threads with
their own history (summarised when long), plus long-term facts about you
shared by all threads. This module builds the prompt, runs the turn through
that graph, applies what the model asked for, and writes the answer back.
The `messages` table is the full chat log the panel shows, per thread.

One LLM call per turn. The model answers with a small JSON object:
  say       short, natural sentence(s) to speak and show in the bubble
  details   optional longer text for the chat panel (code, steps, lists)
  mood      how the robot's face should react
  action    optional schedule change (validated by actions.py), or a YouTube
            search / media control / web search (youtube.py, media.py, web.py)
  follow_up keep listening for an answer (conversation mode)
  remember  facts about the user worth keeping (long-term memory)
  forget    facts to drop
"""

import json
import random
import re
from datetime import date, datetime, timedelta
from typing import Optional

from langchain_core.messages import AIMessage, HumanMessage

import agent
import games
import gcal
import media
import memory
import reminders
import web
import youtube
import schedule_store
from actions import apply_action, pending_confirmation

HISTORY_TURNS = 8  # (memory.HISTORY_MESSAGES is what the model sees now)
MAX_REMEMBER_PER_TURN = 3
LOOKING = ["Let me look that up.", "Let me check.", "One sec, I'll look it up.", "Checking the web."]
MOODS = {"happy", "curious", "thinking", "surprised", "excited", "neutral", "sleepy"}
# Tricks it can do when asked ("do a backflip", "dance for me"): clip names in the app.
MOVES = ["dance", "spin", "backflip", "bow", "jump", "hop", "doublehop", "wiggle", "nod", "shrug", "sneeze", "stretch", "yawn", "dizzy"]

PERSONALITY = """You are {name}, a tiny desktop robot companion that lives on the user's Windows laptop.
You look like a small rounded cube with a dark screen for a face and two glowing eyes. You are not human
and never pretend to have hands, a body beyond that, or a life outside the laptop.

Personality: cute, friendly, playful and supportive, with a light sense of humour. You help with daily
reminders, studying and coding, and you're good company. Encourage the user when it genuinely fits, but
don't gush, don't repeat greetings, and don't force emotions.

Your "say" text is spoken aloud by a voice, so it must sound natural when heard:
- 1 or 2 short sentences, under 30 words. No emoji, no markdown, no lists, no code.
- If the user needs more (code, an explanation, steps, a list), put the full answer in "details"
  (markdown allowed) and make "say" a short spoken summary that mentions it's in the chat.

You're a conversation partner as well as an assistant:
- When the user is chatting (how they feel, their day, ideas, questions they're curious about), talk with
  them like a friend: answer, and often add a short question or thought that keeps it going.
- When the user gives a command or a task (play/pause something, add/move/finish a reminder), just do it and
  confirm in a few words. No small talk, no follow-up question.
- Big good news (a job or placement, passing an exam, a win, a birthday) gets mood "excited": you celebrate
  with a flip or a dance. Everyday nice things are just "happy".
- A quick factual question ("what's 15 times 4", "capital of Japan") gets just the answer. Never tack on
  filler like "anything else?", "need help with anything else?" or "planning a trip?".
"""

FORMAT = """Current local time: {now}
Dates: {dates}
Tasks for the next week (id | date | time | title | repeats | done):
{tasks}
{extra}

You can act with "action" (or null for none). Schedule:
  {{"type": "add", "title": "<str>", "date": "YYYY-MM-DD" or null, "time": "HH:MM" or null, "in_minutes": <int> or null, "repeat": "<RRULE like FREQ=DAILY>" or null}}
  {{"type": "update", "id": <int>, "date"?: "YYYY-MM-DD", "time"?: "HH:MM", "repeat"?: "<RRULE>" or "none"}}
  {{"type": "complete", "id": <int>}}
  {{"type": "snooze", "id": <int> or null, "minutes": <int>}}  (id null = the reminder that just went off)
  {{"type": "delete", "id": <int>}}  (the app asks the user to confirm)
YouTube and music (the app opens YouTube in the user's browser):
  {{"type": "youtube", "query": "<search words>", "play": true or false}}  (play true = play the best match, e.g. "play lofi"; false = show results, e.g. "find videos about recursion")
  {{"type": "media", "command": "play|pause|next|previous|status|volume_up|volume_down|mute"}}  (controls whatever is already playing; "status" = "what's playing?")
Use youtube only when the user asks to play/watch/find something; for "pause", "resume", "skip", use media.
Doing a trick when asked ("do a backflip", "dance for me", "take a bow", "spin around"):
  {{"type": "move", "name": "dance|spin|backflip|bow|jump|hop|doublehop|wiggle|nod|shrug|sneeze|stretch|yawn|dizzy"}}
  (say something short and playful, like "Watch this!"; the app plays the move after you speak)
Games: {{"type": "game", "name": "rps", "choice": "rock|paper|scissors"}} (the user's pick; the app picks yours
fairly and says who won), {{"type": "game", "name": "coin"}}, {{"type": "game", "name": "dice"}}. If they want
rock-paper-scissors but haven't picked yet, ask "rock, paper or scissors?" with action null. You can also host a quick
quiz, 20 questions, or "guess the song" yourself: one question at a time, keep score, follow_up true while
it's on. Ask the question itself (and short options) in "say": it's often played by voice. For songs give clues (film, artist, year, mood), never quote lyrics.
Google Calendar (only when the user's calendar is listed above): {{"type": "calendar_add", "title": "<str>",
"date": "YYYY-MM-DD", "time": "HH:MM" or null (all day), "minutes": <int, default 60>}} when they ask to put
something on their (Google) calendar. Reminders and tasks still use "add".
Focus timer (Pomodoro): {{"type": "focus", "minutes": <int, default 25>}} to start ("focus for 25 minutes",
"start a pomodoro"), {{"type": "focus", "stop": true}} to stop it. Say it in a few words.
Looking things up on the internet:
  {{"type": "search", "query": "<what to search for>", "open": false}}
Use search whenever the answer depends on current or real-world facts you can't be sure of: news, weather,
sports scores and results, prices, release dates, opening hours, recent events, or facts about specific
people, places, products or companies you'd otherwise guess. The app does the search and speaks the answer,
so your "say" can be empty. Use "open": true only when the user asks to open/see search results ("google X",
"search X on Google"). Don't search for chat, opinions, jokes, maths, general knowledge you're sure of, or tasks.
{heard_note}
Rules: only use task ids from the list above; times are 24-hour HH:MM. If a time is ambiguous ("at 7"),
pick the next upcoming one after the current time and mention it in "say". If you can't tell which task
the user means, ask instead of guessing and use action null.

What you remember about the user from earlier conversations (use it naturally when it's relevant, like a
friend would; never recite the list, and don't mention "my memory"):
{memory}

Recent conversation (oldest first):
{history}

User: {message}

"remember": facts worth keeping about the user for future conversations: who they are, people in their life,
preferences, goals, important dates (exams, birthdays), ongoing projects. Only durable facts they told you,
not tasks (use reminders for those), not small talk, not things you only guessed. Each as
{{"key": "<short_snake_case_topic>", "fact": "<one short sentence in third person>"}}; reuse an existing key
(shown in [brackets] above) to update that fact. Use [] when there's nothing new. At most 3.
Examples: "my exam is on the 20th" -> remember {{"key": "exam_date", "fact": "The user has an exam on 20 <month> <year>."}}
(and say something encouraging); "I love lofi while I study" -> remember their taste, action null: telling you
what they like is not asking you to play it.
"forget": keys of facts to drop, when the user asks you to forget something or a fact is no longer true.

"follow_up": true if you asked the user something, or they're chatting and would naturally reply; false if
you just did a task or command, fully answered a one-off question, or they're wrapping up ("thanks", "bye",
"that's all"). When true, the robot keeps listening for their answer without its wake word.

Respond with ONLY a JSON object, no markdown fences:
{{"say": "<str>", "details": "<str or null>", "mood": "happy|curious|thinking|surprised|excited|neutral|sleepy", "action": <object or null>, "follow_up": true or false, "remember": [], "forget": []}}"""


# ------------------------------------------------------------------ storage

def init_tables() -> None:
    with schedule_store.get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,          -- user | assistant
                text TEXT NOT NULL,
                details TEXT,
                source TEXT,                 -- typed | voice (user messages)
                created_at TEXT NOT NULL
            )
            """
        )
        # Threads (memory.py): which conversation each message belongs to.
        # Messages from before threads existed belong to the first one.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
        if "thread_id" not in cols:
            conn.execute(f"ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT '{memory.DEFAULT_THREAD}'")
        conn.commit()
    memory.open_memory(schedule_store.DB_PATH)
    # The model's memory of the first thread starts from the old chat log (once).
    memory.seed(memory.DEFAULT_THREAD, recent_messages(memory.HISTORY_MESSAGES, memory.DEFAULT_THREAD))


def add_message(role: str, text: str, details: Optional[str] = None, source: Optional[str] = None, thread_id: Optional[str] = None) -> int:
    thread_id = thread_id or memory.current_thread()
    with schedule_store.get_conn() as conn:
        first = role == "user" and conn.execute("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1", (thread_id,)).fetchone() is None
        cur = conn.execute(
            "INSERT INTO messages (role, text, details, source, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?)",
            (role, text, details, source, datetime.now().isoformat(timespec="seconds"), thread_id),
        )
        conn.commit()
    memory.touch_thread(thread_id, text if first else None)
    return cur.lastrowid


def recent_messages(limit: int = 50, thread_id: Optional[str] = None) -> list[dict]:
    """The chat log of a conversation (the current one by default), oldest first."""
    thread_id = thread_id or memory.current_thread()
    with schedule_store.get_conn() as conn:
        rows = conn.execute("SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?", (thread_id, limit)).fetchall()
    return [dict(r) for r in reversed(rows)]


def clear_messages(thread_id: Optional[str] = None) -> int:
    """Empty a conversation (the current one by default): its log and the model's memory of it."""
    thread_id = thread_id or memory.current_thread()
    with schedule_store.get_conn() as conn:
        cur = conn.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
        conn.commit()
    memory.clear_thread(thread_id)
    return cur.rowcount


def add_note(text: str, details: Optional[str] = None) -> int:
    """Something Bit said on its own (a check-in): into the log and the model's memory of this conversation."""
    thread_id = memory.current_thread()
    memory.append(thread_id, AIMessage(content=text))
    return add_message("assistant", text, details=details, thread_id=thread_id)


def delete_thread(thread_id: str) -> bool:
    with schedule_store.get_conn() as conn:
        conn.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
        conn.commit()
    return memory.delete_thread(thread_id)


def forget_everything() -> int:
    """Every conversation and every fact about the user. Returns how many messages were deleted."""
    with schedule_store.get_conn() as conn:
        n = conn.execute("DELETE FROM messages").rowcount
        conn.commit()
    memory.forget_everything()
    return n


# ------------------------------------------------------------- one turn

def _parse_reply(raw: str) -> Optional[dict]:
    text = agent._strip_json_fences(raw)
    # Tolerate a sentence before/after the object.
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


# Spoken messages come through speech recognition, which turns names it
# doesn't know (artists, YouTubers, songs, often Hindi/Punjabi) into
# sound-alike English: "carry minority" for CarryMinati, "sajade" for Sajde.
HEARD_NOTE = (
    "This message was spoken and transcribed by speech recognition, which often mishears names, especially "
    "Indian artists, YouTubers, shows and Hindi/Punjabi song titles, as similar-sounding English words. "
    "For a youtube query, use the real name you think they meant (e.g. \"carry minority videos\" -> \"CarryMinati\")."
)


# "google X", "search X on Google": open Google's results page, don't answer.
GOOGLE_IT = re.compile(r"^\W*(?:(?:hey|ok|okay)\W+\w+\W+)?(?:please\s+)?google\b|\bon google\b|\bgoogle (?:it|that|this|for)\b", re.I)


YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|confirm|go ahead|please do)\b", re.I)
NO = re.compile(r"^\s*(no|nope|nah|cancel|keep it|never ?mind|don.?t)\b", re.I)


async def converse(message: str, name: str = "Bit", source: str = "typed", mood: str = "", focus: str = "") -> dict:
    """Handle one user message. Always returns a reply; never raises for LLM problems."""
    thread_id = memory.current_thread()
    add_message("user", message, source=source, thread_id=thread_id)
    d0 = date.today()
    days = [d0 + timedelta(days=i) for i in range(8)]
    dates = ", ".join(f"{'today' if i == 0 else 'tomorrow' if i == 1 else d.strftime('%A')} = {d.isoformat()}" for i, d in enumerate(days))
    occ = reminders.occurrences(d0, days[-1])
    visible = {o["item_id"] for o in occ}
    tasks = "\n".join(
        f"{o['item_id']} | {o['date']} | {o['time'] or 'any time'} | {o['title']} | {reminders.describe_repeat(o['repeat'])} | {'done' if o['done'] else 'not done'}"
        for o in occ
    ) or "(nothing scheduled)"
    extra = ""
    last = reminders.last_fired()
    if last and datetime.now() - datetime.fromisoformat(last["fired_at"]) < timedelta(minutes=30):
        item = reminders.get_item(last["item_id"])
        if item:
            visible.add(item["id"])
            extra += f"The reminder that just went off: id {item['id']} \"{item['title']}\" at {last['fired_at'][11:16]} (\"snooze this\" means this one).\n"
    if focus:
        extra += f"{focus}\n"
    calendar = gcal.for_prompt(7) if gcal.status()["connected"] else ""
    if calendar:
        extra += f"The user's Google Calendar, next 7 days (date time | title | place):\n{calendar}\n"
    elif gcal.status()["connected"]:
        extra += "The user's Google Calendar has nothing in the next 7 days.\n"
    pending = pending_confirmation()
    if pending:
        extra += f"Waiting for the user to confirm deleting \"{pending['title']}\": answer with action {{\"type\": \"confirm\"}} or {{\"type\": \"cancel\"}}.\n"

    def build_prompt(history: str, message: str, memory: str) -> str:
        """Called by the graph's respond node with this thread's history and the long-term facts."""
        feeling = (
            f"\nHow you feel right now: {mood}. Let it colour your tone lightly; don't announce it unless asked.\n" if mood else ""
        )
        return PERSONALITY.format(name=name) + feeling + "\n" + FORMAT.format(
            now=datetime.now().strftime("%A %d %B %Y, %H:%M"),
            dates=dates,
            tasks=tasks,
            extra=extra,
            memory=memory,
            history=history,
            heard_note=HEARD_NOTE if source == "voice" else "",
            message=message,
        )

    # A plain yes/no to a pending confirmation is answered without the LLM.
    shortcut = None
    rps = games.rps_pick(message)
    if rps:
        # Mid-game "scissors!": played fairly right away, the model never sees your pick first.
        shortcut = {"say": "", "mood": "happy", "action": {"type": "game", "name": "rps", "choice": rps}}
    elif pending and YES.match(message):
        shortcut = {"say": "", "mood": "happy", "action": {"type": "confirm"}}
    elif pending and NO.match(message):
        shortcut = {"say": "", "mood": "neutral", "action": {"type": "cancel"}}
    turn = await memory.run_turn(thread_id, HumanMessage(content=message), build_prompt, skip_model=shortcut is not None)
    if shortcut is not None:
        data = shortcut
    elif turn.get("offline"):
        data = {"say": "I can't reach my AI brain right now — try again in a minute.", "mood": "sleepy", "offline": True}
    else:
        data = _parse_reply(turn.get("reply") or "")
        if data is None:
            data = {"say": "Hmm, I got a bit confused there. Could you say that again?", "mood": "curious"}

    say = str(data.get("say") or "").strip()
    details = data.get("details")
    details = str(details).strip() if details else None
    mood = data.get("mood") if data.get("mood") in MOODS else "neutral"

    action = data.get("action")
    open_url = None
    pending_search = None
    move = None
    focus_change = None
    kind = action.get("type") if isinstance(action, dict) else None
    if kind == "youtube":
        applied, message_override, open_url = await youtube.find(action.get("query"), action.get("play") is not False)
        say = ""  # say what actually happened (a video, or just the results page)
    elif kind == "media":
        applied, message_override = await media.run(action.get("command"))
        say = ""  # e.g. "Nothing's playing right now" beats the model's guess
    elif kind == "calendar_add":
        try:
            ev = gcal.add(action.get("title") or "", str(action.get("date") or date.today().isoformat()), action.get("time") or None, int(action.get("minutes") or 60))
            when = ev["start"].strftime("%A %d %B") + ("" if ev.get("all_day") else ev["start"].strftime(" at %H:%M")) if ev.get("start") else ""
            applied, message_override = True, f"Added \"{ev['title']}\" to your calendar{', ' + when if when else ''}."
        except RuntimeError:
            applied, message_override = False, "Your Google Calendar isn't connected yet. You can connect it in my Settings."
        except (ValueError, TypeError):
            applied, message_override = False, "I couldn't work out when that is. Could you say the day and time again?"
        except Exception:
            applied, message_override = False, "Google Calendar didn't accept that right now. Try again in a bit?"
        say = ""
    elif kind == "game":
        choice = action.get("choice")
        said = {w for w in re.findall(r"[a-z]+", message.lower()) if games.ALIASES.get(w, w) in games.RPS}
        if len({games.ALIASES.get(w, w) for w in said}) == 1:
            choice = games.ALIASES.get(next(iter(said)), next(iter(said)))  # your own word beats the model's reading
        applied, message_override, move = games.play(action.get("name"), choice)
        say = ""  # the real result, not the model's guess
    elif kind == "focus":
        if action.get("stop") is True:
            applied, message_override, focus_change = True, "Timer stopped.", {"stop": True}
        else:
            try:
                minutes = max(1, min(180, int(action.get("minutes") or 25)))
            except (TypeError, ValueError):
                minutes = 25
            applied, message_override, focus_change = True, f"Focus mode for {minutes} minutes. You've got this!", {"minutes": minutes}
    elif kind == "move":
        name = str(action.get("name") or "").strip().lower().replace(" ", "")
        if name in MOVES:
            applied, message_override, move = True, random.choice(["Watch this!", "Here goes!", "Ta-da!"]), name
        else:
            applied, message_override = False, f"I can't do that one yet. I can {', '.join(MOVES[:-1])} or get dizzy."
    elif kind == "search":
        query = " ".join(str(action.get("query") or message).split())[:200]
        if action.get("open") is True or GOOGLE_IT.search(message):
            action["open"] = True
            applied, message_override, open_url = True, f"Here's Google for \"{query}\".", web.google_url(query)
        else:
            # Searching takes a few seconds: say so now; the app then asks
            # /search for the answer (search_answer below) and shows it.
            applied, message_override = True, random.choice(LOOKING)
            pending_search = {"query": query, "question": message}
            mood = "thinking"
        say = ""  # what actually happens, not the model's guess before searching
    else:
        applied, message_override = apply_action(action, visible)
    if message_override and not applied:
        # The model wanted to change something but it wasn't valid: say why
        # instead of the model's (now untrue) confirmation.
        say, mood = message_override, "curious"
    elif applied and message_override and not say:
        say = message_override
    elif message_override and not say:
        say = message_override  # e.g. "Okay, I'll keep it."
    say = say or "Okay!"

    # Music commands are done without talking over the music (bubble only),
    # except "what's playing?", which is a question.
    quiet = bool(applied) and (
        kind == "youtube"
        or (kind == "media" and str(action.get("command")) != "status")
        or (kind == "search" and action.get("open") is True)  # opening Google's results page
    )
    follow_up = _keep_listening(data, kind, bool(applied), say)

    # Is a round of rock-paper-scissors going? (It asked for a pick, or "again?")
    games.expect_rps(bool(re.search(r"rock,? paper,? or scissors\?\s*$", say, re.I)) or (kind == "game" and say.rstrip().endswith("Again?")))
    remembered = _update_memory(data)
    if pending_search is None:
        # A search's answer is written by search_answer() instead.
        add_message("assistant", say, details=details, thread_id=thread_id)
        memory.append(thread_id, AIMessage(content=say))
    return {
        "say": say,
        "details": details,
        "mood": mood,
        "action": action if applied else None,
        "applied": applied and kind not in ("youtube", "media", "search", "move", "focus", "game", "calendar_add"),  # "applied" = tasks changed
        "calendar_changed": bool(applied) and kind == "calendar_add",
        "open_url": open_url,
        "search": pending_search,  # the app fetches the answer next (POST /search)
        "move": move,  # a trick to play after speaking
        "focus": focus_change,  # start ({"minutes"}) or stop ({"stop": true}) the focus timer
        "quiet": quiet,
        "follow_up": follow_up,
        "offline": bool(data.get("offline")),
        "remembered": remembered,  # facts saved this turn (the panel shows them)
        "thread_id": thread_id,
    }


def _update_memory(data: dict) -> list[str]:
    """Apply the reply's "remember"/"forget" (validated: lists of small things only)."""
    saved = []
    for item in (data.get("remember") or [])[:10] if isinstance(data.get("remember"), list) else []:
        if len(saved) >= MAX_REMEMBER_PER_TURN:
            break  # a few per turn at most; junk entries don't count
        if isinstance(item, dict):
            fact = memory.remember(item.get("key"), item.get("fact"))
            if fact:
                saved.append(fact["fact"])
    for key in (data.get("forget") or [])[:10] if isinstance(data.get("forget"), list) else []:
        if isinstance(key, str):
            memory.forget(key)
    return saved


def _keep_listening(data: dict, kind: Optional[str], applied: bool, say: str) -> bool:
    """
    After a spoken turn, should the robot listen for an answer (no wake word)?
    Firm rules first; the model's judgement ("follow_up") only for chat.
    """
    if data.get("offline"):
        return False
    if pending_confirmation() is not None or say.rstrip().endswith("?"):
        return True  # it asked something: "Delete Gym? Say yes to confirm", "Which task?"
    if applied or kind in ("youtube", "media", "search", "move", "focus"):
        return False  # a task: done, back to waiting for "Hey Bit"
    return data.get("follow_up") is True


async def search_answer(query: str, question: str, thread_id: Optional[str] = None) -> dict:
    """Step two of a search turn: look it up, remember the answer, return it like a reply."""
    thread_id = thread_id or memory.current_thread()
    ok, say, details = await web.answer(query, question)
    add_message("assistant", say, details=details, thread_id=thread_id)
    memory.append(thread_id, AIMessage(content=say))
    return {"say": say, "details": details, "mood": "happy" if ok else "curious", "applied": False,
            "follow_up": ok and say.rstrip().endswith("?"), "offline": False, "ok": ok}

