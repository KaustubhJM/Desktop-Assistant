# CLAUDE.md

Bit is a desktop robot companion for Windows: a 3D robot (Electron + Three.js)
with reminders, voice, a "Hey Bit" wake word, YouTube/music control, web
search, activity-aware moods and long-term memory. A Python backend (FastAPI)
does the thinking. See `README.md` (architecture) and `app/README.md`
(features, file map).

## Rules

- **Never hard-code or commit API keys.** Keys live in `backend/.env` (gitignored).
  `backend/.env.example` must keep empty values. The Gemini/Groq keys that were
  once committed there must be rotated by the user before any commit.
- **Don't commit or push unless asked.** The repo has no commits yet.
- **Privacy is a feature:** the microphone is only on when asked (push-to-talk)
  or when hands-free is enabled, and audio is never saved. Window titles and the
  screen never leave the laptop (`activity.py` emits one word), with one
  exception the user asked for: "help me with this" sends a screenshot to a
  vision model, then one with each message while Bit keeps looking (👀, ends
  on "stop looking" / 3 quiet minutes); only on request, never saved, and the
  panel says where it went (`vision.py`, `screen.ts`). Only the user's question goes to search.
  Keep it that way, and say what is sent where in the UI.
- **Don't break what works.** Change internals behind existing interfaces
  (e.g. `conversation.converse()` keeps its signature and reply shape), and keep
  existing tests passing unchanged.
- **Verify before claiming.** Run the tests and the relevant self-test section;
  for anything visual, look at the captured screenshot. Report failures honestly.
- After backend changes the user must **restart Bit** (Ctrl+C, `npm run dev`);
  remind them.

## Commands

All on Windows. Backend Python is the venv: `backend\venv\Scripts\python`.

```bash
# backend tests (each prints "N/N passed")
cd backend
venv/Scripts/python tests/test_reminders.py   # scheduler, repeats, chat actions
venv/Scripts/python tests/test_tools.py       # YouTube, media, conversation mode, web search, model lanes
venv/Scripts/python tests/test_wake.py        # "Hey Bit" (needs local models)
venv/Scripts/python tests/test_activity.py    # coding/watching/music detection
venv/Scripts/python tests/test_memory.py      # threads, summaries, long-term facts
venv/Scripts/python tests/test_beat.py        # tempo/phase on synthetic drum tracks
venv/Scripts/python tests/test_calendar.py    # Google Calendar with a fake calendar

# app
cd app
npm run typecheck
npm run selftest                                       # everything (~5 min, robot appears on screen)
BIT_SELFTEST_ONLY=memory,search npm run selftest       # just some sections
```

Self-test sections: `unit captures dynamic transparency click drag peek system
size voice tasks backend youtube search look memory effects mood checkins focus
wander beat wake conversation activity realclick metrics`, plus `ontop` (only when named: opens a full-screen Edge
InPrivate window). Results go to `app/selftest-output/results.json` with
screenshots next to it. The self-test uses throwaway settings and databases and
no API keys.

Use `PYTHONIOENCODING=utf-8` when printing non-ASCII from Python in Git Bash.

## Architecture (where things live)

Backend (`backend/`), started by the app with a per-launch token:
- `main.py`: FastAPI routes, WebSocket push, lifespan.
- `conversation.py`: personality and prompt, one turn (`converse`), applying the
  reply's action, conversation-mode rules (`_keep_listening`), search step two
  (`search_answer`).
- `memory.py`: LangGraph memory. Threads (SQLite checkpointer), summaries,
  long-term facts (SQLite store), `LaneChatModel` (LangChain wrapper over
  `agent._call_llm`). Stored in `bit-memory.db`.
- `agent.py`: free-tier model lanes (Groq/Gemini rotation with rest-on-429),
  `call_search` for built-in web search.
- `actions.py` validates schedule actions. `reminders.py` and `scheduler.py`
  handle items, RRULE repeats, snoozes, exactly-once firing and missed-reminder catch-up.
- `web.py` (search answers), `vision.py` ("help me with this" from a screenshot,
  `agent.call_vision`), `youtube.py`, `media.py`, plus `media_helper.py`
  (a separate process: Windows' media API).
- `speech.py`: Whisper STT (local, or Groq "online") and Kokoro TTS.
  `wake.py`: Vosk tripwire plus Whisper confirmation. `activity.py`: what you're doing.

App (`app/src/`):
- `main/`: lifecycle (`index.ts`), robot window, presence/peeking, tray,
  assistant turn flow and panel IPC (`assistant.ts`), `wake.ts`,
  `activity.ts`, `onTop.ts`, `links.ts` (URL allow-lists), `screen.ts`
  (screenshot, Bit excluded via content protection), `selftest.ts`.
- `renderer/src/`: robot rendering (`robot/` brain, clips, eyes, stage),
  voice (`voice.ts`), the chat panel (`panel/`).
- `shared/types.ts`: every IPC and command type.

A turn: panel/voice/wake, then `runTurn` (assistant.ts), then `POST /chat`, then
`converse()` (memory graph, then model, then actions), then the reply to the
robot and panel. A search answers "Let me look that up" first, then
`POST /search`; "help me with this" takes the screenshot, says "Let me take a
look", then `POST /look`.

## Gotchas (learned the hard way)

- npm's registry is blocked on this network: `app/.npmrc` uses
  `registry.yarnpkg.com`.
- Windows' media API (winrt) **crashes the process** (0xC0000005) when it runs
  alongside onnxruntime/CTranslate2. Keep all winrt calls in
  `media_helper.py`, via `media.run()` and `media.sessions()`.
- Full-screen Chromium browsers bury always-on-top windows after focus changes.
  `onTop.ts` re-asserts "on top" every second; don't remove it.
- LangGraph 1.x only injects config into a node typed `config: RunnableConfig`.
  Summarising runs after the reply and must never raise.
- Tests swap `agent._call_llm` for a fake. Any new LLM call shifts their
  scripted replies: put it after the answer, or make it tolerate an empty queue.
- `media.ISOLATE = False` in tests that use fake media sessions.
- Self-tests must mute robot audio (`setAudioMuted(true)`), disable
  `followActivity`, `checkIns` and `wander` (the user's real music, a morning
  hello or a walk would skew other sections; runSelftest does this and
  sections re-enable what they test), start from a quiet robot
  (`untilQuiet()`: leftover speech counts as busy), and use stubbed
  `setLinkOpener` so no real tabs open. Don't use a fresh Edge profile: it
  signs into the user's Microsoft account. Use InPrivate.
- Anything answered without the model (a plain "yes", a mid-game
  rock-paper-scissors pick) must not call it at all, summary included: tests
  assert the scripted reply is left unused. Tests that leave game state on
  must reset it (`games.expect_rps(False)`).
- Audio-device code (PyAudioWPatch loopback in `beat.py`) runs in its own
  process too, like winrt in `media_helper.py`. `soundcard` crashes here
  (0xC0000374); don't use it.
- High DPI (125–150%): use `setBounds` (not `setPosition`) to move windows,
  and `SetProcessDpiAwarenessContext(-4)` in PowerShell screen checks.
- Inline shell heredocs mangle quotes and backslashes. Write edit scripts to
  the scratchpad as files and run them.
- Media "next" on a single YouTube video: Windows accepts it and the browser
  drops it (the "next" button is off). `media.py` checks the buttons and seeks
  to the end instead (autoplay starts "Up next").
- LangGraph copies plain-string `configurable` values into checkpoint metadata
  (the memory DB). Pass anything that must not be stored (screenshots) as an
  object (`memory.Screenshot`); a test checks no screenshot reaches a DB file.
- False wakes come from the Whisper spelling hint ("Bit is a little robot.
  Hey Bit!"): it makes Whisper hear "Bit" in "Bittu", "beta", "bitter" (a
  benchmark of Hindi/English sound-alikes: ~9/44 got through). A stricter
  unhinted check also dropped 1-3 of 16 real commands, so instead the reply
  side stays quiet on background talk: `conversation.sounds_like_background`
  (repeats, hint read back; no model call) and the model's `ignore` action
  (voice only). Keep the "hm?" look before the chime on both paths.
- The Vosk wake model only knows dictionary words. "Hey Bit" always works,
  custom names may not.

## Conventions

- Match the surrounding style: explanatory module docstrings and comments that
  say *why*, and plain-language user-facing text.
- Each feature gets backend unit tests (fakes, no network) **and** a self-test
  section exercising the real app. Check real-model behaviour with throwaway
  scripts on an empty temp DB (`REMINDER_DB_PATH`), never the user's data.
- Back up the user's database before a schema migration
  (`backend/schedule.db.backup-before-*`).
- Free tiers are small (Gemini 2.5 Flash: 20 requests/day; Groq: 8k tokens/min
  per model). Avoid extra model calls per turn.
