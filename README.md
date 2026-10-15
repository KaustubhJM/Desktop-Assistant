# Desktop Robot Companion

A tiny 3D robot that lives on your Windows desktop: it blinks, looks around,
hides at the screen edge when you're away, greets you once per session, and
reminds you what's next — with a live LLM deciding *how* to phrase each
reminder and understanding plain-English updates like "push my 3pm to 4".

## How it fits together

```
┌──────────────────────────────┐   IPC    ┌──────────────────────────────┐
│  Robot window (Three.js)      │ <──────> │  Electron main process        │
│  eyes, moves, state machine   │          │  window, tray, peeking,       │
│  bubble + ask box             │          │  greeting, backend supervisor │
└──────────────────────────────┘          └──────────────┬───────────────┘
                                                          │ HTTP + WebSocket
                                                          │ 127.0.0.1, per-launch token
                                           ┌──────────────▼───────────────┐
                                           │  Python backend (FastAPI)     │
                                           │  schedule_store · scheduler   │
                                           │  agent (Gemini → Groq)        │
                                           └──────────────────────────────┘
```

- **app/** — the desktop app (Electron + TypeScript + Three.js). It starts and
  stops the backend itself. See [app/README.md](app/README.md).
- **backend/reminders.py** is the ground truth for your schedule: tasks with
  a date, optional time and optional repeat rule (RFC 5545 RRULE, the format
  Google Calendar uses), per-occurrence completion, snoozes, and a log of
  every notification sent (so none fires twice). The LLM never edits it
  directly: it returns JSON that **actions.py** validates and applies.
- **backend/scheduler.py** checks every 20 seconds (and on wake-up) for
  anything that became due since its last check, so sleep and shutdown
  never lose a reminder; late ones are summarised in one message. Timing
  never depends on the LLM; if it's down the reminder fires with plain wording.
- **backend/tests/test_reminders.py** — 21 simulated-clock tests (repeats,
  snooze, sleep gaps, restarts, clock changes, duplicates, chat actions):
  `venv\Scripts\python tests\test_reminders.py`.
- **backend/agent.py** calls the LLM through a list of free "lanes" (several
  Groq and Gemini models, fastest first). Each free tier is small (Gemini 2.5
  Flash: 20 requests a day; Groq: 8,000 tokens a minute per model), so when one
  says "slow down" it's skipped until it resets and the next one answers.
  Override with `LLM_LANES` in `.env`. It also phrases reminders.
- **backend/memory.py** is Bit's memory, built on LangGraph: separate
  conversation threads (SQLite checkpointer, so they survive restarts),
  short-term memory per thread (old messages folded into a running summary
  when a thread gets long), and long-term facts about you in a LangGraph
  store shared by every thread. A LangChain chat model wraps the free-tier
  lanes. Stored in `bit-memory.db`. Tests: `tests\test_memory.py`.
- **backend/conversation.py** is the robot's personality; it runs each turn
  through memory.py's graph: one call per turn returns a short spoken reply, optional longer
  details for the chat panel, a mood, an optional action (validated by
  **actions.py** before anything is saved), whether to keep listening for
  your answer (conversation mode), and facts to remember or forget.
- **backend/web.py** answers questions that need the internet (news,
  weather, scores, prices…) using the providers' built-in web search (Groq
  browser search, Gemini Google Search grounding), as a second step of the
  chat turn so the robot can say "let me look that up" first.
- **backend/vision.py** answers "help me with this" from a screenshot the
  app takes when you ask (a model that can see: Gemini or Qwen on Groq),
  the same two-step way: "let me take a look", then the answer.
- **backend/gcal.py** connects Google Calendar (read, remind, add);
  **briefing.py** writes the morning hello; **games.py** has fair
  rock-paper-scissors, coins and dice; **occasions.py** knows festivals and
  your birthday; **beat.py** finds a song's tempo from the speakers'
  loopback (its own process) so the robot dances in time.
- **backend/youtube.py** turns "play lofi on YouTube" into a link (the best
  video with an optional free YouTube API key, otherwise the search results);
  the app opens it in your browser and only ever opens YouTube links.
- **backend/media.py** controls whatever is playing (YouTube in the browser,
  Spotify…) through Windows' media sessions: play, pause, skip, volume,
  "what's playing?". Tests: `venv\Scripts\python tests	est_tools.py`.
- **backend/apps.py** opens apps and games from your Start menu ("open VS
  Code", "launch WhatsApp"). The AI only names the app; the backend picks the
  closest Start menu entry and starts it the way the Start menu does. It never
  runs commands or opens files, skips uninstallers and scripts, and your app
  list never leaves the laptop. Tests: `venv\Scripts\python tests\test_apps.py`.
- **backend/wake.py** is the optional hands-free "Hey Bit": a tiny offline
  recogniser (Vosk) listens for the name, and local Whisper confirms it and
  transcribes the command. Audio stays in memory and is never saved or sent.
  Tests: `venv\Scripts\python tests	est_wake.py`.
- **backend/activity.py** works out what you're doing (coding, watching,
  music) from the app in front and Windows' media sessions, so the robot can
  match it. Only that one word leaves it. Tests: `tests\test_activity.py`.
- **backend/speech.py** runs speech recognition (faster-whisper) and the
  voice (Kokoro) locally on the CPU — audio never leaves the laptop.

## Setup

1. Free API keys: Gemini (https://aistudio.google.com/apikey) and Groq
   (https://console.groq.com/keys).
2. Backend, once:
   ```bash
   cd backend
   python -m venv venv
   venv\Scripts\pip install -r requirements.txt
   venv\Scripts\python download_models.py   # local voice, speech recognition, wake word (~550 MB)
   copy .env.example .env         # then paste your keys into .env
   ```
3. App:
   ```bash
   cd app
   npm install
   npm run dev
   ```

The robot appears in the bottom-right corner. Click it to open the chat
panel, or press the push-to-talk shortcut (shown in the panel's Settings) and talk. Use the tray icon for
everything else.

For development you can also run the backend by hand (`cd backend && venv\Scripts\uvicorn main:app`, no
token needed in that mode) and use http://localhost:8000/docs — but don't run
it alongside the app, or reminders show twice.

## Roadmap

Milestones 1 (living robot), 2 (desktop presence), 3 (voice and chat) and
4 (reminders: repeats, snooze, missed-reminder catch-up) are done. Milestone 5
is done: YouTube, media controls, web search and Google Calendar. Bit also
has memory (threads, long-term facts), moods, check-ins, a focus timer,
games, wandering and beat-synced dancing. Next: polish and an installer (M6). Then polish and installer (M6).
