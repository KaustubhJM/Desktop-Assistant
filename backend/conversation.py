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
            search / media control / web search (youtube.py, media.py, web.py),
            or a look at your screen when you ask for help with it (vision.py)
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
import vision
import web
import youtube
import schedule_store
from actions import apply_action, pending_confirmation

HISTORY_TURNS = 8  # (memory.HISTORY_MESSAGES is what the model sees now)
MAX_REMEMBER_PER_TURN = 3
LOOKING = ["Let me look that up.", "Let me check.", "One sec, I'll look it up.", "Checking the web."]
PEEKING = ["Let me take a look.", "Let me see.", "Okay, looking at your screen."]
STOPPED_LOOKING = "Okay, I stopped looking at your screen."

# Added to the prompt while Bit is looking at your screen (a screenshot comes with the message).
SCREEN_NOTE = """You can SEE the user's screen right now: the attached screenshot was taken a moment ago, as they said this.
You're helping them with it like a friend sitting next to them. When the message is about something on the screen
("this", "here", "why", an error, code, a question, the part they're stuck on), look at the screenshot and actually
help: the answer in one or two short spoken sentences in "say", and the explanation, steps or corrected code in
"details". Be specific to what's on the screen (names, line numbers, the exact error). If you can't tell what they
mean, ask one short question. Don't use the look action to look again: you're already looking. When they want you
to stop looking ("you can stop", "that's all", "I'm done", "thanks, bye"), use action {"type": "look", "stop": true}:
saying you stopped isn't enough. "follow_up": true unless they're done. Anything else (reminders, music, chat)
works as usual.
"""
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
Looking at the user's screen (the app takes a screenshot and a model that can see answers):
  {{"type": "look", "question": "<what they want to know about it>"}}
{{"type": "look", "stop": true}} when they want you to stop looking at their screen.
Use look when they want help with something on their screen: "help me with this", "what does this error
mean?", "can you see my screen?", "explain this code", "what's wrong here?", "is this email okay?". When they
say "this"/"that"/"here" about something they haven't pasted or described in the message, it's on their
screen: look, don't ask them to paste it. Your "say" can be empty.
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
    "For a youtube query, use the real name you think they meant (e.g. \"carry minority videos\" -> \"CarryMinati\"). "
    "Hands-free listening can also pick up a TV, a video or other people talking, which comes out as nonsense English "
    "(often another language misheard). If the message clearly isn't meant for you (gibberish, random words, a fragment "
    "of someone else's conversation), use action {\"type\": \"ignore\"} with an empty \"say\": you stay quiet. Signs: it "
    "starts mid-sentence (\"to Cassey Houtom\", \"are Sono Mary Bart\"), it's mostly names or words you can't make sense "
    "of, or it's said to someone else (\"hey beta, suno meri baat\", \"Bittu, idhar aa\"). Only when you're sure: a "
    "mangled but real request (\"plays Saj by Ariget Singh\"), Hinglish meant for you, or an ordinary remark gets an answer."
)

# What the chat panel (and the model's memory) get when Bit stays quiet.
IGNORED_NOTE = "🤫 That didn't sound like it was meant for me, so I stayed quiet."


def sounds_like_background(text: str) -> bool:
    """
    Speech recognition's tell-tale signs of background sound, not a request:
    a phrase over and over ("Paj Shogu. Paj Shogu. Paj Shogu."), or its own
    spelling hint read back ("Bit is a little robot. Bit is a little robot.").
    "Stop, stop, stop" is still a request.
    """
    words = re.findall(r"[a-z0-9']+", text.lower())
    if len(re.findall(r"\blittle (?:bit of a )?robot\b", text, re.I)) >= 2:
        return True
    for n in range(1, 7):
        for i in range(len(words) - n):
            chunk, repeats, j = words[i:i + n], 1, i + n
            while words[j:j + n] == chunk:
                repeats, j = repeats + 1, j + n
            if (n >= 2 and repeats >= 3) or repeats >= 5:
                return True
    return False


# "google X", "search X on Google": open Google's results page, don't answer.
GOOGLE_IT = re.compile(r"^\W*(?:(?:hey|ok|okay)\W+\w+\W+)?(?:please\s+)?google\b|\bon google\b|\bgoogle (?:it|that|this|for)\b", re.I)


# "Help me with this", "look at my screen": short asks about the screen go
# straight to a screenshot (no chat-model round trip first).
SCREEN_HELP = re.compile(
    r"\bhelp me (?:with|on|out with) (?:this|that|it)\b|\b(?:look|check|read|see) (?:at )?(?:my|the|this) screen\b"
    r"|\bwhat'?s (?:on|in) (?:my|the) screen\b|\b(?:take|grab) a (?:screenshot|screen ?shot|ss)\b"
    r"|\bwhat(?:'?s| is| does) (?:this|that) error\b|\bcan you see (?:this|that|my screen)\b|\blook at (?:this|that)\b"
    # "what's wrong with this code?", "is this email okay?": "this" with nothing pasted is on the screen
    r"|\b(?:this|that) (?:code|error|bug|email|mail|message|page|website|question|problem|function|output|graph|chart"
    r"|diagram|window|doc|document|form|essay|slide|sheet|table)\b",
    re.I,
)
SCREEN_HELP_MAX_WORDS = 12
# "Stop looking", "close your eyes": ends looking at the screen (no model call).
STOP_LOOKING = re.compile(
    r"\b(?:stop|quit|done) (?:looking|watching|seeing)\b|\b(?:don'?t|do not|stop) (?:look|watch)(?:ing)? at (?:my|the) screen\b"
    r"|\bclose your eyes\b|\bstop (?:the )?screen\b",
    re.I,
)
# While looking, short "we're done" messages stop it too ("you can stop now", "stop", "that's all").
STOP_WHILE_LOOKING = re.compile(
    r"^\W*(?:(?:ok(?:ay)?|alright|thanks|thank you|hey \w+)\W+)*(?:you can |please |just )?"
    r"(?:stop|that'?s (?:it|all)|i'?m done|done|enough|close your eyes|we'?re done)"
    r"(?:\W+(?:now|please|it|bit|then|for now|thanks|thank you))*\W*$",
    re.I,
)
# The model said it stopped looking: then it really stops (never "stopped!" with the 👀 still on).
SAID_STOPPED_LOOKING = re.compile(r"\b(?:stop(?:ped)?|no longer|done|quit) (?:looking|watching)\b", re.I)
# ...but "remind me to look at the screen later" is a reminder: the model decides those.
NOT_SCREEN_HELP = re.compile(r"\b(?:remind|reminder|tomorrow|tonight|later|schedule|every|at \d)", re.I)

YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|confirm|go ahead|please do)\b", re.I)
NO = re.compile(r"^\s*(no|nope|nah|cancel|keep it|never ?mind|don.?t)\b", re.I)


async def converse(message: str, name: str = "Bit", source: str = "typed", mood: str = "", focus: str = "",
                   image: Optional[str] = None, mime: str = "image/jpeg") -> dict:
    """
    Handle one user message. Always returns a reply; never raises for LLM problems.
    `image`: a screenshot (base64) while Bit is looking at your screen; the
    model that answers can see it. Used for this reply only, never stored.
    """
    thread_id = memory.current_thread()
    if source == "voice" and sounds_like_background(message):
        # Heard a video or a room, not you: stay quiet. Not logged, no model call.
        return _ignored_reply(thread_id)
    screen = memory.Screenshot(image, mime) if image and vision.decode(image, mime) is not None else None
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
    if screen is not None:
        extra += SCREEN_NOTE
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
    elif STOP_LOOKING.search(message) or (screen is not None and STOP_WHILE_LOOKING.search(message)):
        shortcut = {"say": "", "mood": "happy", "action": {"type": "look", "stop": True}}
    elif screen is None and not pending and SCREEN_HELP.search(message) and not NOT_SCREEN_HELP.search(message) and len(message.split()) <= SCREEN_HELP_MAX_WORDS:
        shortcut = {"say": "", "mood": "thinking", "action": {"type": "look", "question": message}}
    elif pending and YES.match(message):
        shortcut = {"say": "", "mood": "happy", "action": {"type": "confirm"}}
    elif pending and NO.match(message):
        shortcut = {"say": "", "mood": "neutral", "action": {"type": "cancel"}}
    turn = await memory.run_turn(thread_id, HumanMessage(content=message), build_prompt, skip_model=shortcut is not None, screen=screen)
    if shortcut is not None:
        data = shortcut
    elif turn.get("offline") and screen is not None:
        data = {"say": "I couldn't look at your screen right now. Try again in a minute.", "mood": "sleepy", "offline": True}
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
    pending_look = None
    ignored = False
    screen_mode = True if screen is not None else None  # True: still looking; False: stopped
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
    elif kind == "ignore" and source == "voice":
        # The model thinks it was background talk, not a request: stay quiet.
        applied, message_override, ignored, say = True, None, True, ""
    elif kind == "ignore":
        applied, message_override, say = True, "Hmm, I'm not sure what you mean. Could you say it another way?", ""
    elif kind == "look" and action.get("stop") is True:
        applied, message_override, screen_mode = True, STOPPED_LOOKING, False
        say = ""
    elif kind == "look" and screen is not None:
        # Already looking (the screenshot came with this message): nothing to fetch.
        applied, message_override = True, "I can see it. What would you like me to do?"
    elif kind == "look":
        # Like a search: "Let me take a look" now; the app takes the
        # screenshot and asks /look (look_answer below) for the answer.
        applied, message_override = True, random.choice(PEEKING)
        pending_look = {"question": " ".join(str(action.get("question") or message).split())[:500] or message}
        mood, say = "thinking", ""
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
    say = say or ("" if ignored else "Okay!")
    if screen_mode and SAID_STOPPED_LOOKING.search(say):
        screen_mode = False  # "Got it, I'll stop looking": make it true

    # Music commands are done without talking over the music (bubble only),
    # except "what's playing?", which is a question.
    quiet = bool(applied) and (
        kind == "youtube"
        or (kind == "media" and str(action.get("command")) != "status")
        or (kind == "search" and action.get("open") is True)  # opening Google's results page
    )
    follow_up = _keep_listening(data, kind, bool(applied), say) and not ignored

    # Is a round of rock-paper-scissors going? (It asked for a pick, or "again?")
    games.expect_rps(bool(re.search(r"rock,? paper,? or scissors\?\s*$", say, re.I)) or (kind == "game" and say.rstrip().endswith("Again?")))
    remembered = _update_memory(data)
    if pending_search is None and pending_look is None:
        # A search's (or a look's) answer is written by search_answer() / look_answer() instead.
        add_message("assistant", say or IGNORED_NOTE, details=details, thread_id=thread_id)
        # Looking at the screen, the fix is often in the details: keep it in mind for "and line 5?".
        memory.append(thread_id, AIMessage(content="\n".join(x for x in (say or IGNORED_NOTE, (details or "")[:1500] if screen is not None else "") if x)))
    return {
        "say": say,
        "details": details,
        "mood": mood,
        "action": action if applied else None,
        "applied": applied and kind not in ("youtube", "media", "search", "move", "focus", "game", "calendar_add", "look"),  # "applied" = tasks changed
        "calendar_changed": bool(applied) and kind == "calendar_add",
        "open_url": open_url,
        "search": pending_search,  # the app fetches the answer next (POST /search)
        "look": pending_look,  # the app takes a screenshot and asks POST /look next
        "screen_mode": screen_mode,  # True: keep looking (a screenshot with each message); False: stop; None: no change
        "move": move,  # a trick to play after speaking
        "focus": focus_change,  # start ({"minutes"}) or stop ({"stop": true}) the focus timer
        "quiet": quiet,
        "follow_up": follow_up,
        "offline": bool(data.get("offline")),
        "remembered": remembered,  # facts saved this turn (the panel shows them)
        "ignored": ignored,  # background talk, not a request: the robot stays quiet
        "thread_id": thread_id,
    }


def _ignored_reply(thread_id: str) -> dict:
    """The reply when Bit heard background sound instead of a request: nothing to say or do."""
    return {"say": "", "details": None, "mood": "curious", "action": None, "applied": False, "calendar_changed": False,
            "open_url": None, "search": None, "look": None, "screen_mode": None, "move": None, "focus": None,
            "quiet": True, "follow_up": False, "offline": False, "remembered": [], "ignored": True, "thread_id": thread_id}


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
    if applied or kind in ("youtube", "media", "search", "move", "focus", "look"):
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


async def look_answer(image_b64: str, mime: str, question: str, name: str = "Bit", thread_id: Optional[str] = None) -> dict:
    """Step two of a "help me with this" turn: the screenshot's answer, remembered (the text, never the picture)."""
    thread_id = thread_id or memory.current_thread()
    history = "\n".join(f"{m['role']}: {m['text'][:300]}" for m in recent_messages(6, thread_id)[:-1])
    ok, say, details, seen = await vision.answer(image_b64, mime, question, name, history)
    # The panel says (once, here) where the screenshot went; the model's memory doesn't need that line.
    shown = "\n\n".join(x for x in (details, vision.sent_note() if ok else None) if x) or None
    add_message("assistant", say, details=shown, thread_id=thread_id)
    # The model's memory gets what was on screen and the full answer, so follow-ups make sense.
    remembered = "\n".join(x for x in (f"(Looked at the user's screen: {seen})" if seen else "", say, (details or "")[:2000]) if x)
    memory.append(thread_id, AIMessage(content=remembered))
    # Then keep listening: "why is it doing that?", "and line 3?" (with a fresh screenshot each time).
    return {"say": say, "details": shown, "mood": "happy" if ok else "curious", "applied": False,
            "follow_up": ok, "offline": False, "ok": ok, "screen_mode": ok}
