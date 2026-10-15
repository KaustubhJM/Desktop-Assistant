# Bit — desktop robot

The new desktop app: a small 3D robot that lives on your Windows desktop.
It starts and stops the Python backend in `../backend` by itself, so there is
only one thing to run.

## Run it

```bash
cd app
npm install
npm run dev
```

Requirements: Node 22+, and the backend's virtual environment set up once
(`cd backend && python -m venv venv && venv\Scripts\pip install -r requirements.txt`,
plus a `backend/.env` with your API keys — see `backend/.env.example`).

> If `npm install` fails with connection resets, your network may be blocking
> registry.npmjs.org. This folder's `.npmrc` uses Yarn's official mirror
> (registry.yarnpkg.com), which serves the same packages.

Stop any backend you started by hand first, otherwise both would show the
same reminders.

## Using it

- **Drag** the robot anywhere. Clicks on the empty space around it go
  through to whatever is underneath. Swing it around a lot and it gets dizzy.
- **It has a life of its own**: 23 moves (dance, bow, sneeze, yawn, peer,
  look back, double hop, backflip…), each played a little differently every
  time (speed, size, direction), sometimes chained together. Landings and
  boops wobble and settle on springs. It's livelier in the morning and
  yawnier late at night.
- **It matches what you're doing** (Settings → "Reacts to what I'm doing", on
  by default): while you code (VS Code, terminals, IDEs, GitHub/LeetCode…)
  it's in focus mode — focused face, only small calm moves, less often;
  while you watch YouTube or a video it's happy and looks towards the middle
  of your screen; when a song plays it dances, then bobs to the beat and
  dances often (a gentle bob only if you're coding). Watching or listening
  without touching anything doesn't count as "away", so it won't hide or doze
  off mid-video. It never looks at the screen: every 2 seconds it reads which
  app is in front (name and window title) and what's playing in Windows'
  media sessions, on the laptop, and turns that into one word — nothing is
  stored, logged or sent.
- **Feelings** (main/mood.ts): happiness (chatting, petting, clicks, finishing
  tasks, plugging in), boredom (grows while you're here but ignoring it) and
  energy (time of day, battery: tired after midnight, or below 20% on battery). The mood — playful, happy, content, bored,
  lonely, tired — changes what it does (bored: tries to get your attention;
  tired: yawns), lightly colours how it talks, and shows in the chat header.
- **Little flourishes**: music notes while it grooves, hearts when petted, Zzz
  when asleep, confetti when you finish a task, sparkles when excited, stars
  when dizzy, a badge on special days (diya at Diwali, kite on 15 August, a
  cake on your birthday if it knows it), and tiny R2-D2 chirps (Settings →
  Sounds turns chimes and chirps off).
- **Tricks and games**: "do a backflip / dance / take a bow"; big good news
  ("I passed!") gets a flip. Rock-paper-scissors (it picks fairly before
  seeing yours; your pick never goes to the AI mid-game), coin flips, dice,
  and quizzes / 20 questions / guess-the-song hosted by voice.
- **Focus timer**: "focus for 25 minutes" (or the tray): calm focused look
  with a 🍅, no check-ins, the time left in the chat header; then confetti
  and a 5-minute break (15 after every fourth). "Stop the timer" cancels.
- **Check-ins** (Settings, on by default; at most one per 40 min, only while
  you're at the laptop, never mid-conversation or in focus): a morning hello
  (weather, today's tasks, special days), a stretch break after 90 min of
  coding, a late-night nudge, "two hours of videos and X is due tomorrow",
  and "you finished N things today" in the evening. Each goes into the chat,
  so you can just reply.
- **Wandering** (Settings, on by default): every 6–12 minutes, when idle, a
  stroll along the bottom of the screen, or it climbs onto the title bar of
  the window you're using (not maximised) and hops down when it moves; with
  two screens it follows you. Never while you code or focus. Where you drag
  it stays its home.
- **Dancing to the actual beat**: while a song plays it listens to the
  laptop's sound output (the speakers' loopback, never the microphone), works
  out the tempo, and bobs in time. In memory only, in its own little process.
- **Google Calendar** (Settings → Connect, after a one-time setup below):
  your events show in Today (📅, read-only), remind you 15 minutes before and
  at the start, the AI knows them ("what's on tomorrow?"), and "put dentist on
  my calendar Friday at 4" adds one.
- **It notices your mouse pointer**: its eyes (and a little lean) follow the
  pointer when it moves nearby, until it gets bored and looks away. It
  startles if the pointer rushes at it, and wiggles happily if you rest the
  pointer on it. Only the pointer's position is used, only to animate its
  eyes; turn it off in Settings ("Eyes follow my mouse").
- **Click** it to open the chat panel (click again or Esc to close):
  conversation history, today's tasks, and settings (name, voice, speech
  recognition quality, size, look, and "Forget all" for its memory).
- **Talk**: press the mic button or the push-to-talk shortcut, speak, and pause —
  it stops listening by itself. The shortcut is the first free one of
  Ctrl+Alt+Space, Ctrl+Alt+M, Alt+Shift+M, Ctrl+Alt+J, Ctrl+Shift+Space (other
  apps may already own some); Settings in the panel shows which one you got. The microphone is only on while it's
  listening (its eyes widen with little sound bars, the panel's mic button
  turns red, and the tray tooltip says "microphone on").
- **Hands-free "Hey Bit"** (off by default — Settings → "Hands-free", or the
  tray): say "Hey Bit, play some lofi" or just "Hey Bit", wait for its
  listening face, then say what you want. While it's on, the microphone stays
  open, but the audio is only processed in memory on this laptop — never
  saved, never sent; only the sentence after the name goes to the AI, as with
  push-to-talk. It's muted while Bit talks and closed while the screen is
  locked. Costs about 3–5% of one CPU core. If you rename the robot, "Hey
  <new name>" works too (and "Hey Bit" always does). It reacts as you say it:
  a quick curious glance the moment it thinks it heard its name, then — about
  half a second after "Bit", even mid-sentence — its listening face (with a
  soft two-note chime only if you've stopped talking, so the chime never lands
  on your words). A falling chime means it has stopped listening. Music or a
  video that's playing pauses as soon as it's sure you said its name and
  resumes once it has answered (unless you asked it to pause, skip, or play
  something else), so it hears you, not the song. A short thinking pause
  ("remind me to… call mom") doesn't cut you off. If the quick recogniser
  misses the name (over music), a bigger one on the laptop gets a second
  listen. Each attempt leaves one line in `logs/backend.log` (what happened,
  never what was said). When it first perks up, it also opens the connection
  to the AI service (an empty request: no audio, no words) so the answer comes
  ~0.5 s sooner. (While hands-free is on, the speech recogniser stays loaded
  so there's no pause after a quiet spell.) Sometimes a video or people talking nearby (a "Hey
  Bittu", a "Hey beta") sounds enough like its name to wake it. If what it
  then hears is clearly not for it (gibberish, a phrase over and over, a bit
  of someone else's conversation) it stays quiet: just the curious "hm?", the
  falling chime, and a 🤫 note in the chat with what it heard. Typed messages
  are never ignored.
- **Speech recognition** (Settings): *Fast* and *Accurate* run on the laptop;
  *Online* sends just the command you spoke (never the "Hey Bit" listening,
  and only from the name onwards) to Groq's Whisper large-v3-turbo, which is
  much better with names (Indian artists, YouTubers, Hindi/Punjabi titles)
  and quicker (~0.6 s). If it's unreachable, the local model is used. Either
  way, when you ask for a video, the AI corrects misheard names
  ("carry minority" → CarryMinati) before searching.
- **It remembers you**: tell it about yourself ("my exam is on the 20th",
  "I'm into jazz", "my friend Priyanshu…") and it keeps those facts and uses
  them naturally later, in any conversation ("good luck today!"). Each reply
  that saved something says so ("✎ Remembered: …"). Settings → "What I
  remember about you" lists them; × forgets one, "Forget everything" wipes
  all conversations and facts. Or just say "forget that I like lofi".
- **Separate conversations**: the Chat tab's picker switches between them,
  "+ New chat" starts a fresh one (named after its first message), the bin
  deletes one. Each has its own history; long ones are summarised so Bit
  keeps the thread without slowing down. Everything is stored on this
  laptop (`backend/bit-memory.db`); when Bit answers, the recent
  conversation and the facts are sent to the AI provider, like your message.
- **Conversations**: when you talk to it (wake word or push-to-talk) and it
  asks you something, or you're just chatting, it keeps listening for your
  answer — no "Hey Bit" needed — until you go quiet for a few seconds or say
  "thanks, that's all". Tasks are different: "play lofi", "pause", "next song"
  are done quietly (a bubble, no talking over your music, no listening), and
  reminders get one short spoken confirmation. If what it hears while waiting
  is just noise (TV, fan, music), the conversation ends without a word. Typed
  chat never opens the microphone by itself.
- **Replies** are spoken in a soft local voice (Kokoro) and shown in the
  bubble/panel. Click the robot, press Stop talking, or press the shortcut
  to interrupt. Turn speech off in Settings for text-only replies.
- Typed or spoken, you can ask anything, or change today's schedule
  ("push DSA practice to 6pm", "add gym at 7", "I finished the assignment").
- **Away for a while** — 2 minutes with no keyboard or mouse input at all, by
  default (tray → "Away after") — and it glides to the nearest screen edge and
  peeks out, blinking and glancing around. To see it right away: tray →
  "Peek from the edge now". Hover over it and
  it peeks further; click it and it comes back. A due reminder brings it out
  too. Away much longer and its eyes get sleepy.
- **Ctrl+Alt+B** brings it back from anywhere (also: click the tray icon).
- **Always on top really means on top**: a full-screen browser (YouTube full
  screen, F11) used to climb above it whenever it got focus back — e.g. right
  after you clicked the robot — so it vanished while still working. It now
  re-asserts "on top" once a second (tray → "Always on top" turns that off).
  `npm run selftest` with `BIT_SELFTEST_ONLY=ontop` reproduces it with a real
  full-screen Edge (InPrivate) window, real clicks and screenshots.
- **Greeting**: once per Windows sign-in session — the first launch after you
  sign in, or the first time you open it by hand that session. Relaunching
  never greets twice.
- **Screen locked or laptop asleep**: it stops drawing entirely.
- **Size**: Small (default), Medium or Large, from the tray. The window shrinks
  with the robot, so it covers less of your screen.
- **Tray icon**: show/hide, bring back, move to the corner, peek now, the
  away time, greeting on/off, start with Windows, always on top, size, theme
  (ivory/cyan or silver/purple), and "Try a state" / "Try a move" menus.
- **Tasks and reminders**: open the panel's **Today** tab to add one (name,
  date, optional time, and Once / Every day / Weekdays / Every week / Every
  month), tick it off, or delete it (asks first). It shows the next 7 days.
  Or just say/type it: "remind me to study DSA at 7 PM", "take a break in
  30 minutes", "assignment due Friday", "every night at 9 remind me to plan
  tomorrow", "mark the assignment done", "delete the gym reminder" (it asks
  you to confirm), "snooze this for 10 minutes".
- **Reminders** fire 15 minutes before a timed task and at its start (date-only
  deadlines at 9:00 that day). The robot comes out of hiding, jumps, glows,
  speaks, and shows **Done** / **Snooze 10 min** buttons in its bubble. If it's
  hidden (tray), you get a Windows notification instead.
- **Asleep or switched off?** Nothing is lost: reminders up to 10 minutes late
  still fire, older ones arrive as a single "while you were away, you
  missed…" message (only the last 24 hours), and it checks the moment the
  laptop wakes. Each reminder fires exactly once.
- **Questions that need the internet**: "what's the weather in Pune?", "who
  won the match yesterday?", "any news about ISRO?", "gold price today",
  "when does the next IPL season start?". It says "Let me look that up"
  straight away, thinks while it searches, then speaks a short answer; the
  chat panel shows the key facts and clickable source links (they open in
  your browser). "Google best biryani in Hyderabad" / "search X on Google"
  opens Google's results instead. It uses the AI providers' own built-in web
  search with the keys you already have (Groq first, Gemini as backup); only
  your question is sent. Chat, jokes, maths and reminders don't search.
- **Help with what's on your screen**: "help me with this", "what does this
  error mean?", "what's wrong with this code?", "is this email okay?", "look
  at my screen". It takes a screenshot of the screen your mouse pointer is
  on (Bit and its chat window left out), says "Let me take a look", and a
  model that can see (Gemini Flash-Lite first, Qwen on Groq as backup, same
  keys) explains it, answers it or fixes it; the spoken answer is short and
  the chat panel gets the full explanation or the corrected code. Then it
  **keeps looking while you talk about it** (👀 on Bit and in the chat
  header): ask "why is it crashing?", "how do I fix line 3?", "I'm stuck on
  this function" and each question comes with a fresh screenshot, answered by
  Bit's normal brain with eyes (so reminders, music and the rest still work).
  "Stop looking" (or switching chats, or 3 quiet minutes) ends it.
  **This is the one time your screen leaves the laptop, and only when you
  ask**: screenshots are taken only when you say something while it's
  looking, go to that model with that message, are never saved, and the
  panel says where they went.
- **YouTube and music**: "play lofi on YouTube", "put on some Arijit Singh
  songs", "find videos explaining recursion" open YouTube in your default
  browser (and Bit dances when a video starts). Without a key it opens the
  search results; add a free `YOUTUBE_API_KEY` to `backend/.env` (see
  `.env.example`) and "play" goes straight to the best video. Only YouTube
  links are ever opened, and only your search words are sent to YouTube.
  "Play something similar to this song" picks a specific different song
  (never the one playing again). For that, and for questions like "what's
  this song?", the title and artist of what's playing go to the AI with that
  one message, and the chat says so (🎵); otherwise they stay on the laptop.
- **Controlling what's playing** (YouTube, Spotify, anything that shows in
  Windows' volume flyout): "pause", "resume", "next song", "go back", "turn
  it up/down", "mute", "what's playing?". "Pause" never starts something that
  was stopped. This happens on the laptop; nothing is sent anywhere.
- Launching it a second time just brings the existing robot back.

> **Start with Windows** in development registers `electron.exe <this folder>`,
> which runs the last `npm run build`. The proper installer comes in Milestone 6.

## Google Calendar: one-time setup

1. https://console.cloud.google.com → your project → **APIs & Services →
   Library** → enable **Google Calendar API**.
2. **OAuth consent screen** → External → add yourself as a **test user**.
3. **Credentials → Create credentials → OAuth client ID → Desktop app** →
   Download JSON → save it as `backend/client_secret.json` (gitignored).
4. Restart Bit → Settings → Google Calendar → **Connect** → approve in the
   browser. The token is saved as `backend/token_google.json` (gitignored);
   only Calendar *events* access is requested.

## Layout

| Path | What it does |
| --- | --- |
| `src/main/index.ts` | App lifecycle: single instance, window, tray, backend, shutdown |
| `src/main/robotWindow.ts` | Transparent window, click-through, dragging, keeping it on screen |
| `src/main/backend.ts` | Starts/stops the Python backend with a per-launch secret token |
| `src/main/tray.ts` | Tray icon and menu |
| `src/main/presence.ts` | Idle → peeking/sleepy, lock/sleep pause, launch at login, Ctrl+Alt+B |
| `src/main/edges.ts` | Which screen edge to peek from (monitor-layout aware) |
| `src/main/session.ts` | Once-per-Windows-session greeting |
| `src/main/assistant.ts` | Conversation and voice plumbing, mic permission, push-to-talk |
| `src/main/panelWindow.ts` | The chat panel window |
| `src/main/mood.ts` | Happiness, boredom, energy → a mood |
| `src/main/checkins.ts` | Morning hello, stretch breaks, late-night and deadline nudges, evening "nice work" |
| `src/main/focus.ts` | Pomodoro focus timer and breaks |
| `src/main/wander.ts` | Strolls, perching on your window, following you to another screen |
| `src/renderer/src/robot/effects.ts` | Notes, hearts, Zzz, confetti, sparkles, special-day badges |
| `src/main/onTop.ts` | Keeps the robot (and chat panel) above full-screen windows |
| `src/main/activity.ts` | Matching what you're doing: on/off, "watching isn't away", where to look |
| `src/main/wake.ts` | "Hey Bit" on/off, muting while it talks, running what it heard |
| `src/main/screen.ts` | The screenshot for "help me with this" (Bit left out of it) |
| `src/main/links.ts` | Opens YouTube links in your browser (allow-list: https YouTube watch/search only) |
| `src/renderer/src/voice.ts` | Speaker (local voice, interruptible, no overlap) and Recorder (mic + end-of-speech detection) |
| `src/renderer/src/panel/` | Chat panel UI |
| `src/preload/index.ts` | The small, fixed API the robot page may use |
| `src/renderer/src/robot/model.ts` | The 3D body, built in code |
| `src/renderer/src/robot/eyes.ts` | The LED pixel display and eye drawing |
| `src/renderer/src/robot/expressions.ts` | Eye presets and easing between them |
| `src/renderer/src/robot/clips.ts` | Keyframed moves: bounce, hop, jump, tilt, spin, backflip… |
| `src/renderer/src/robot/brain.ts` | State machine, blinking, gaze, idle behaviours |
| `src/main/selftest.ts` | Dev-only verification run (see below) |

## Self-test

```bash
npm run selftest
```

Runs the real app with throwaway settings, a throwaway reminder database and
no API keys. It captures every expression and move to `selftest-output/`,
checks window transparency, click-through (asking Windows where a click would
land), dragging and clamping, a real backend reminder and chat round trip, and
measures CPU and memory. The robot appears on screen for about 4 minutes.
