// main.ts — the robot window: builds the robot, runs the render loop, and
// wires up the mouse (click-through, drag, click), the speech bubble, the
// voice (speaking and listening), backend events and commands from main.

import "./style.css";
import {
  layoutFor,
  PEEK_STYLE,
  type BackendEvent,
  type ClipName,
  type CommandEnvelope,
  type Edge,
  type ExpressionName,
  type Layout,
  type Mood,
  type RobotCommand,
  type ThemeName,
  type Urgency,
  type VoiceState,
} from "../../shared/types";
import { Brain } from "./robot/brain";
import { EyeDisplay } from "./robot/eyes";
import { buildRobot, THEMES } from "./robot/model";
import { Stage } from "./robot/stage";
import { chime, chirp, lastChime, lastChirp, Recorder, setSounds, Speaker, type Chirp } from "./voice";
import { Effects } from "./robot/effects";

const api = window.robot;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;
const bubbleText = document.getElementById("bubble-text") as HTMLDivElement;
const bubbleActions = document.getElementById("bubble-actions") as HTMLDivElement;

const config = await api.getConfig();
let layout: Layout = layoutFor(config.size);
applyLayoutCss(layout);
const stage = new Stage(canvas, layout);
const eyes = new EyeDisplay();
const robot = buildRobot(eyes.canvas, stage.renderer.capabilities.getMaxAnisotropy());
stage.scene.add(robot.root);
const brain = new Brain();
const fx = new Effects(document.getElementById("fx") as HTMLCanvasElement);
/** The robot's head in the window (effects come from here). */
const head = () => stage.project(robot.screen, 0.55);
brain.onMoment = (moment) => {
  if (moment === "pet") api.moment("pet");
  if (moment === "pet") fx.emit("heart", head(), 3, layout.scale);
  else if (moment === "dizzy") fx.emit("star", head(), 5, layout.scale);
  else if (moment === "excited") fx.emit("sparkle", head(), 9, layout.scale);
  beep(moment === "pet" ? "happy" : moment === "startle" ? "eep" : moment === "excited" ? "happy" : "boop");
};
/** A chirp, unless it's talking or listening (beeps would talk over it / be recorded). */
function beep(kind: Chirp): void {
  if (voiceState === "idle" && !recorder.active && !paused) chirp(kind);
}
let lastNote = 0;
/** Today's festival/birthday badge (the 🍅 replaces it during a focus session, 👀 while looking at your screen). */
let dayBadge: { emoji: string; label: string } | null = null;
let lookingAtScreen = false;
function showBadge(): void {
  fx.setBadge(lookingAtScreen ? { emoji: "👀", label: "Looking at your screen" } : brain.focus ? { emoji: "🍅", label: "Focus session" } : dayBadge);
}
let lastZ = 0;
brain.followMouse = config.followMouse;
const speaker = new Speaker(config.speak, (text) => api.tts(text));
const recorder = new Recorder();
const hitTargets = [robot.body, robot.screen];
/** Set when something changes the display without moving the face (theme, freeze). */
let forceRedraw = true;

applyTheme(config.theme);

// ---------------------------------------------------------------- render loop

let last = performance.now();
let calmSkip = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (paused) {
    last = now; // screen locked / asleep: draw nothing
    return;
  }
  // When nothing fast is happening, ~30 fps is plenty for breathing and sway.
  if (!brain.busy && !brain.frozen && shiftSettled()) {
    calmSkip = !calmSkip;
    if (calmSkip) return;
  }
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
}

function step(dt: number): void {
  updateShift(dt);
  if (brain.state === "speaking") brain.level = speaker.level();
  else if (brain.state === "listening") brain.level = recorder.level;
  const faceChanged = brain.update(dt);
  applyPose();
  if (faceChanged || forceRedraw || brain.indicator !== "none") {
    forceRedraw = false;
    eyes.draw(brain.face.drawable(), { kind: brain.indicator, phase: brain.indicatorPhase, level: brain.level });
    robot.screenTexture.needsUpdate = true;
  }
  stage.render();
  // Flourishes: notes while grooving to a song, Zzz while asleep.
  const t = performance.now() / 1000;
  if (brain.groove > 0.5 && !peek && t - lastNote > 0.8) {
    fx.emit("note", head(), 1, layout.scale);
    lastNote = t;
  }
  if (brain.state === "sleepy" && t - lastZ > 1.8) {
    fx.emit("z", head(), 1, layout.scale);
    lastZ = t;
  }
  fx.step(dt, head(), layout.scale, t);
}

function applyPose(): void {
  const p = brain.pose;
  robot.root.position.x = p.px;
  robot.lift.position.y = p.py;
  robot.squash.scale.set(p.sx, p.sy, p.sx);
  robot.spin.rotation.set(p.rx, p.ry, p.rz);
  const air = Math.min(1, Math.max(0, p.py));
  robot.shadow.scale.setScalar(1 - 0.4 * air);
  (robot.shadow.material as { opacity: number }).opacity = 0.55 * (1 - 0.55 * air);
}

/** Window and bubble sizes follow the robot's size setting. */
function applyLayoutCss(l: Layout): void {
  const root = document.documentElement.style;
  root.setProperty("--win-w", `${l.window.width}px`);
  root.setProperty("--win-h", `${l.window.height}px`);
  root.setProperty("--bubble-bottom", `${l.bubbleBottom}px`);
  root.setProperty("--bubble-max", `${l.bubbleMax}px`);
  root.setProperty("--bubble-font", l.scale < 0.75 ? "12.5px" : "13.5px");
}

function applyTheme(theme: ThemeName): void {
  const t = THEMES[theme];
  robot.setTheme(t);
  eyes.setColor(t.eyes);
  fx.colors = { a: t.eyes, b: theme === "ivory-cyan" ? "#9b7bff" : "#4fe3ff" }; // notes/sparkles match the eyes
  brain.face.pupilTarget = t.pupil;
  forceRedraw = true;
}

// ------------------------------------------------------------------- peeking
// Main moves the window flush to a screen edge; here the robot slides past
// that edge (a camera shift), leans out and looks back at the screen.

let paused = false;
let peek: Edge | null = null;
let peekTimer: number | undefined;
let lastHoverPeek = 0;
const shift = { x: 0, y: 0, tx: 0, ty: 0 };

function setShiftTarget(x: number, y: number): void {
  shift.tx = x;
  shift.ty = y;
}

function shiftSettled(): boolean {
  return Math.abs(shift.x - shift.tx) < 0.4 && Math.abs(shift.y - shift.ty) < 0.4;
}

function updateShift(dt: number): void {
  if (shiftSettled()) {
    if (shift.x !== shift.tx || shift.y !== shift.ty) {
      shift.x = shift.tx;
      shift.y = shift.ty;
      stage.setShift(shift.x, shift.y);
    }
    return;
  }
  const k = 1 - Math.exp(-dt * 5.5);
  shift.x += (shift.tx - shift.x) * k;
  shift.y += (shift.ty - shift.y) * k;
  stage.setShift(shift.x, shift.y);
}

function waitForShift(maxMs: number): Promise<void> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const check = () => (shiftSettled() || performance.now() - t0 > maxMs ? resolve() : requestAnimationFrame(check));
    requestAnimationFrame(check);
  });
}

function peekPrepare(edge: Edge): void {
  bubble.classList.add("hidden");
  // Look towards where it's heading, with a little hop.
  const dir = edge === "left" ? -1 : edge === "right" ? 1 : 0;
  brain.glance(0.8 * dir, edge === "bottom" ? 0.6 : 0, 1.2);
  brain.playClip("hop");
}

async function peekEnter(edge: Edge): Promise<void> {
  const p = { ...layout.peek[edge], ...PEEK_STYLE[edge] };
  peek = edge;
  brain.setState("peeking");
  brain.setGazeCentre(p.look[0], p.look[1]);
  brain.setLean(p.lean.ry, p.lean.rz);
  setShiftTarget(p.hidden[0], p.hidden[1]);
  await waitForShift(1600);
  schedulePeekBehaviour();
}

async function peekExit(): Promise<void> {
  window.clearTimeout(peekTimer);
  peek = null;
  brain.setLean(0, 0);
  brain.setGazeCentre(activityLook[0], activityLook[1]);
  brain.setDrowsy(false);
  setShiftTarget(0, 0);
  brain.setState("idle");
  await waitForShift(1400);
  brain.setState("happy");
}

/** While hidden: glance about, peek out further, duck back, blink. */
function schedulePeekBehaviour(): void {
  window.clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    if (!peek) return;
    const p = { ...layout.peek[peek], ...PEEK_STYLE[peek] };
    const r = Math.random();
    if (r < 0.3) peekFurther(2400, "listening");
    else if (r < 0.72) brain.glance(p.look[0] + (Math.random() - 0.5) * 0.7, p.look[1] + (Math.random() - 0.5) * 0.5, 1.3);
    else if (r < 0.86) duck();
    else brain.blinkNow(true);
    schedulePeekBehaviour();
  }, 5000 + Math.random() * 8000);
}

function peekFurther(ms: number, expression: "listening" | "happy"): void {
  if (!peek) return;
  const edge = peek;
  const p = { ...layout.peek[edge], ...PEEK_STYLE[edge] };
  setShiftTarget(p.far[0], p.far[1]);
  brain.flash(expression, ms / 1000);
  window.setTimeout(() => {
    if (peek === edge) setShiftTarget(p.hidden[0], p.hidden[1]);
  }, ms);
}

function duck(): void {
  if (!peek) return;
  const edge = peek;
  const p = { ...layout.peek[edge], ...PEEK_STYLE[edge] };
  setShiftTarget(p.hidden[0] * 1.12, p.hidden[1] * 1.12);
  window.setTimeout(() => {
    if (peek === edge) setShiftTarget(p.hidden[0], p.hidden[1]);
  }, 900);
}

function canPeek(): boolean {
  return (
    !peek &&
    !dragging &&
    !speaker.speaking &&
    !recorder.active &&
    brain.state !== "notification" &&
    brain.base !== "thinking" &&
    brain.base !== "listening" &&
    bubble.classList.contains("hidden")
  );
}

function onUserIdle(sleepy: boolean): void {
  if (peek) {
    brain.setDrowsy(sleepy);
    if (!sleepy) brain.blinkNow(true);
  } else if (sleepy && brain.base === "idle" && brain.state !== "notification") {
    // Also from a short transient (happy, curious...): this signal is sent
    // once, so ignoring it here would leave the robot awake indefinitely.
    brain.setState("sleepy");
    beep("sleepy");
  } else if (!sleepy && brain.base === "sleepy") {
    brain.setState("idle");
    brain.setState("surprised"); // oh! you're back
  }
}

// ------------------------------------------------------- mouse: hover, drag, click

let interactive = false;
let press: { x: number; y: number; id: number } | null = null;
let dragging = false;
let lastDrag = { x: 0, t: 0 };

function overUi(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("#bubble:not(.hidden)");
}

/** Clicks are caught only over the robot or its bubble; elsewhere they pass through. */
function updateInteractive(x: number, y: number, target: EventTarget | null): { overRobot: boolean; interactive: boolean } {
  const overRobot = stage.hits(x, y, hitTargets);
  // Hovering a peeking robot coaxes it out a little.
  if (overRobot && peek && performance.now() - lastHoverPeek > 4000) {
    lastHoverPeek = performance.now();
    peekFurther(1800, "happy");
  }
  const next = overRobot || overUi(target) || dragging;
  document.body.classList.toggle("over-robot", overRobot);
  if (next !== interactive) {
    interactive = next;
    api.setClickThrough(!interactive);
  }
  return { overRobot, interactive };
}

document.addEventListener("mousemove", (e) => {
  // The self-test drives hovering itself; your real mouse would race it.
  if (!config.selftest) updateInteractive(e.clientX, e.clientY, e.target);
});

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !stage.hits(e.clientX, e.clientY, hitTargets)) return;
  if (peek) {
    api.peekExit(); // clicking a peeking robot brings it back out
    return;
  }
  press = { x: e.screenX, y: e.screenY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!press) return;
  if (!dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 5) {
    dragging = true;
    brain.dragging = true;
    brain.flash("surprised", 0.5);
    lastDrag = { x: e.screenX, t: performance.now() };
    api.dragStart();
  }
  if (dragging) {
    const now = performance.now();
    const dtMs = Math.max(1, now - lastDrag.t);
    const v = ((e.screenX - lastDrag.x) / dtMs) * 1000;
    brain.dragVelocity = brain.dragVelocity * 0.7 + v * 0.3;
    lastDrag = { x: e.screenX, t: now };
  }
});

function release(): void {
  if (dragging) {
    dragging = false;
    brain.dragging = false;
    brain.dragVelocity = 0;
    api.dragEnd();
    brain.dropped(); // soft landing, or dizzy if it was swung around
  } else if (press) {
    onRobotClick();
  }
  press = null;
}
canvas.addEventListener("pointerup", release);
canvas.addEventListener("lostpointercapture", () => {
  if (press || dragging) release();
});

function onRobotClick(): void {
  if (brain.state === "notification") {
    dismissBubble();
    return;
  }
  if (speaker.speaking) {
    stopSpeaking(); // clicking a talking robot interrupts it
    return;
  }
  brain.boop(); // boop!
  beep("boop");
  api.moment("click");
  api.togglePanel();
}

// -------------------------------------------------------------------- bubble

let bubbleTimer: number | undefined;
/** The reminder the bubble's Done / Snooze buttons act on. */
let bubbleReminder: { itemId: number; occurrence: string } | null = null;

function showBubble(text: string, opts: { urgency?: Urgency; sticky?: boolean; reminder?: { itemId: number; occurrence: string } } = {}): void {
  bubbleText.textContent = text;
  bubbleReminder = opts.reminder ?? null;
  bubbleActions.classList.toggle("hidden", !bubbleReminder);
  bubble.classList.toggle("urgent", opts.urgency === "high");
  bubble.classList.remove("hidden");
  window.clearTimeout(bubbleTimer);
  const ms = opts.reminder ? 30_000 : opts.sticky ? 12_000 : Math.max(4000, text.length * 75);
  bubbleTimer = window.setTimeout(dismissBubble, ms);
}

function dismissBubble(): void {
  window.clearTimeout(bubbleTimer);
  bubble.classList.add("hidden");
  if (brain.state === "notification") {
    brain.settle();
    speaker.stop();
  }
}

bubble.addEventListener("click", dismissBubble);

bubbleActions.addEventListener("click", async (e) => {
  e.stopPropagation(); // don't also dismiss via the bubble's own click
  const button = (e.target as HTMLElement).closest("button");
  const reminder = bubbleReminder;
  if (!button || !reminder) return;
  const action = button.dataset.action as "done" | "snooze";
  dismissBubble();
  const res = await api.reminderAction(action, reminder.itemId, reminder.occurrence);
  if (action === "done") {
    brain.setState("happy");
    if (!res.ok) showBubble("Hmm, I couldn't mark that as done.", { urgency: "high" });
  } else if (res.ok && res.until) {
    brain.flash("content", 1.2, "nod");
    showBubble(`Okay — I'll remind you again at ${res.until}.`);
  } else {
    showBubble("Hmm, I couldn't snooze that.", { urgency: "high" });
  }
});

// --------------------------------------------------------------------- voice

let voiceState: VoiceState = "idle";

function setVoiceState(state: VoiceState): void {
  if (state === voiceState) return;
  voiceState = state;
  api.voiceState(state);
}

const MOOD_FACE: Record<Mood, ExpressionName> = {
  happy: "happy",
  excited: "excited",
  curious: "curious",
  surprised: "surprised",
  thinking: "neutral",
  neutral: "neutral",
  sleepy: "content",
};

interface SayOptions {
  urgency?: Urgency;
  bubble?: boolean;
  mood?: Mood;
  clip?: ClipName;
  /** Show it but don't speak (music commands: don't talk over the music). */
  quiet?: boolean;
  /** Conversation: when it finishes, listen for the answer (no wake word needed). */
  listenAfter?: boolean;
  /** Keep a thinking face afterwards ("let me look that up" — the answer is coming). */
  thenThink?: boolean;
}

/** Bumped by every new reply and by interruptions, so only the latest reply may open the mic afterwards. */
let replyGeneration = 0;

/** Show and speak a reply (or reminder/greeting). Never overlaps: a new one cuts off the old. */
function say(text: string, opts: SayOptions = {}): void {
  const mood = opts.mood ?? "neutral";
  const gen = ++replyGeneration;
  if (opts.bubble !== false) showBubble(text, { urgency: opts.urgency });
  brain.setSpeakingFace(MOOD_FACE[mood]);
  // "Let me look that up" keeps thinking until it can speak (and after).
  if (opts.thenThink) brain.setState("thinking");
  else if (brain.base === "thinking" || brain.base === "listening") brain.setState("idle");
  const finished = () => {
    if (opts.thenThink) {
      if (gen === replyGeneration) {
        brain.setState("thinking");
        setVoiceState("thinking");
      }
      return;
    }
    react(mood, opts.clip);
    if (opts.listenAfter && gen === replyGeneration) void listenForAnswer(gen);
  };
  if (!speaker.enabled || opts.quiet) {
    speaker.stop();
    setVoiceState("idle");
    finished();
    return;
  }
  void speaker.say(text, {
    onStart: () => {
      brain.setState("speaking");
      setVoiceState("speaking");
    },
    onEnd: () => {
      if (brain.base === "speaking") brain.setState("idle");
      setVoiceState("idle");
      finished();
    },
  });
}

/**
 * Conversation mode: after a reply that expects an answer, listen again
 * without the wake word. Saying nothing for a few seconds ends it quietly.
 */
async function listenForAnswer(gen: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 250)); // let the last word fade so it doesn't hear itself
  if (gen !== replyGeneration || recorder.active || paused) return;
  brain.setState("listening");
  setVoiceState("listening");
  void chime("listen"); // your turn
  await recordAndSend(() => {
    void chime("done"); // conversation over, no fuss
    brain.flash("content", 1);
  }, true);
}

/** A small physical reaction to the mood of a reply (or a specific move, like dancing to music). */
function react(mood: Mood, clip?: ClipName): void {
  if (clip) brain.flash(mood === "neutral" ? "happy" : MOOD_FACE[mood], 2.4, clip);
  else if (mood === "happy") brain.flash("happy", 1.4, "bounce");
  // Good news: the full excited state (a jump, spin, backflip or dance).
  else if (mood === "excited") brain.setState("excited");
  else if (mood === "surprised") brain.flash("surprised", 1.2, "startle");
  else if (mood === "curious") brain.flash("curious", 1.4, "tilt");
}

function stopSpeaking(): void {
  replyGeneration++; // interrupted: don't start listening for an answer afterwards
  speaker.stop();
  if (brain.base === "speaking") brain.setState("idle");
  setVoiceState("idle");
}

/** Mic button / push-to-talk: start listening, or stop if already listening. */
async function toggleListen(): Promise<void> {
  if (recorder.active) {
    recorder.stop();
    return;
  }
  stopSpeaking();
  if (peek) api.peekExit();
  bubble.classList.add("hidden");
  brain.setState("listening");
  setVoiceState("listening");
  void chime("listen");
  await recordAndSend(() => {
    void chime("done");
    brain.flash("curious", 1.2);
  });
}

/** Record until you stop talking, then hand it to main (transcribe + run the turn). */
async function recordAndSend(onSilence: () => void, followUp = false): Promise<void> {
  let recording;
  try {
    recording = await recorder.start(350); // the chime plays during the first moment
  } catch {
    brain.setState("idle");
    setVoiceState("idle");
    showBubble("I can't use the microphone. Check Windows Settings → Privacy → Microphone.", { urgency: "high" });
    return;
  }
  if (!recording.hadSpeech) {
    brain.setState("idle");
    setVoiceState("idle");
    onSilence();
    return;
  }
  brain.setState("thinking");
  setVoiceState("thinking");
  const res = await api.voiceInput(recording.wav, followUp); // main transcribes it and runs the turn; the reply comes back as a command
  if (followUp && res.ok && !res.text) {
    // Only noise in the answer window: the conversation is over.
    if (brain.base === "thinking") brain.setState("idle");
    setVoiceState("idle");
    onSilence();
  }
}

// ------------------------------------------------------------- what you're doing

/** Where the eyes rest while watching something with you (towards the middle of the screen). */
let activityLook: [number, number] = [0, 0];

/** Coding -> focused, watching -> happy and eyes on the video, a song -> dance (see brain.ts ACTIVITY). */
function applyActivity(activity: "none" | "coding" | "watching" | "music", music: boolean, look: [number, number]): void {
  activityLook = look;
  // Only greet the change with a move when it's just hanging out (not mid-conversation or hidden).
  const free = !peek && !paused && voiceState === "idle";
  brain.setActivity(activity, music, free);
  if (!peek) brain.setGazeCentre(look[0], look[1]);
}

// -------------------------------------------------------------- backend events

api.onBackendEvent((event: BackendEvent) => {
  if (event.type === "reminder") {
    if (recorder.active) recorder.stop();
    brain.setState("idle");
    brain.setState("notification");
    const reminder = event.item_id && event.occurrence ? { itemId: event.item_id, occurrence: event.occurrence } : undefined;
    showBubble(event.text, { urgency: event.urgency ?? "normal", sticky: true, reminder });
    // The notification face stays on while it speaks. The voice state follows it: if this cut
    // off a reply, that reply never reports "done", and "Hey Bit" would stay muted.
    void speaker.say(event.text, { onStart: () => setVoiceState("speaking"), onEnd: () => setVoiceState("idle") });
  } else if (event.type === "wake") {
    // "Hey Bit": the backend heard its name (the mic there is never recorded).
    if (recorder.active) return; // push-to-talk is already handling it
    if (event.phase === "attention") {
      // Maybe its name (the eager first check): a quick, silent "hm?".
      if (brain.base === "idle" && voiceState === "idle" && !peek) brain.flash("curious", 0.9);
    } else if (event.phase === "listening") {
      // Confirmed while you're still talking: the face shows it; a chime would land on your words.
      if (!event.speaking) void chime("listen");
      if (peek) api.peekExit();
      bubble.classList.add("hidden");
      brain.setState("listening");
      brain.flash("listening", 0.6, "hop");
    } else if (event.phase === "command") {
      if (brain.base === "listening") brain.setState("thinking");
    } else if (event.phase === "cancel" && brain.base === "listening") {
      void chime("done");
      brain.setState("idle");
      brain.flash("curious", 1.2);
    }
  } else if (event.type === "beat") {
    brain.setBeat(event.bpm ?? 0, event.next_beat_ms ?? 0);
  } else if (event.type === "activity") {
    applyActivity(event.activity ?? "none", !!event.music, event.look ?? [0, 0]);
  } else if (event.type === "info") {
    say(event.text, { urgency: event.urgency });
  } else if (event.type === "status" && event.text === "backend-down") {
    brain.setState("idle");
    brain.flash("sleepy", 3);
    showBubble("I can't reach my brain (the backend), so reminders are paused.", { urgency: "high" });
  }
});

// -------------------------------------------------------------------- commands

api.onCommand(async ({ id, command }: CommandEnvelope) => {
  const result = await runCommand(command);
  api.commandDone(id, result);
});

async function runCommand(c: RobotCommand): Promise<unknown> {
  switch (c.kind) {
    case "state":
      brain.setState(c.state);
      return;
    case "clip":
      brain.playClip(c.clip);
      return;
    case "say":
      say(c.text, { urgency: c.urgency });
      return;
    case "reply":
      say(c.say, { mood: c.mood, bubble: c.bubble, clip: c.clip, quiet: c.quiet, listenAfter: c.listenAfter, thenThink: c.thenThink });
      return;
    case "listen-toggle":
      void toggleListen();
      return;
    case "stop-speaking":
      stopSpeaking();
      return;
    case "voice":
      return; // main picks the voice when it synthesises
    case "attention":
      brain.attention(c.dx, c.dy, c.dist, c.over, c.closing);
      return;
    case "activity":
      applyActivity(c.activity, c.music, c.look);
      return;
    case "effect":
      fx.emit(c.effect, head(), c.effect === "confetti" ? 46 : c.effect === "sparkle" ? 9 : 3, layout.scale);
      if (c.effect === "confetti") beep("ok");
      return;
    case "sounds":
      setSounds(c.on);
      return;
    case "mood":
      brain.setMood(c.mood);
      return;
    case "walk":
      brain.setWalking(c.on ? (c.dir ?? 1) : 0);
      return;
    case "focus":
      brain.setFocus(c.on);
      showBadge();
      return;
    case "ignored":
      // Heard a video or a room, not you: the curious "hm?" first, then the soft "done" chime. No voice.
      if (brain.base === "thinking" || brain.base === "listening") brain.setState("idle");
      brain.flash("curious", 1.2);
      setVoiceState("idle");
      setTimeout(() => void chime("done"), 450);
      return;
    case "looking":
      lookingAtScreen = c.on;
      showBadge();
      return;
    case "badge":
      dayBadge = c.emoji ? { emoji: c.emoji, label: c.label } : null;
      showBadge();
      return;
    case "follow-mouse":
      brain.followMouse = c.enabled;
      return;
    case "test-voice":
      say(`Hi! I'm ${config.name}. This is how I sound.`, { mood: "happy" });
      return;
    case "theme":
      applyTheme(c.theme);
      return;
    case "speak-enabled":
      speaker.enabled = c.enabled;
      if (!c.enabled) stopSpeaking();
      return;
    case "greet":
      brain.setState("happy");
      brain.playClip("hop");
      say(c.text, { mood: "happy" });
      return;
    case "can-peek":
      return canPeek();
    case "peek-prepare":
      peekPrepare(c.edge);
      return;
    case "peek-enter":
      await peekEnter(c.edge);
      return;
    case "peek-exit":
      await peekExit();
      return;
    case "user-idle":
      onUserIdle(c.sleepy);
      return;
    case "layout":
      layout = layoutFor(c.size);
      applyLayoutCss(layout);
      stage.setLayout(layout);
      forceRedraw = true;
      step(0);
      return;
    case "pause":
      paused = c.on;
      if (c.on) {
        stopSpeaking();
        recorder.stop();
      }
      else if (!peek) brain.flash("happy", 1.2, "nod"); // welcome back
      return;
    case "freeze":
      brain.freeze(c);
      forceRedraw = true;
      step(0);
      await nextFrames(2);
      return;
    case "unfreeze":
      brain.unfreeze();
      return;
    case "debug-backdrop":
      document.body.classList.toggle("backdrop", c.on);
      await nextFrames(2);
      return;
    case "debug-hover": {
      const target = document.elementFromPoint(c.x, c.y);
      return updateInteractive(c.x, c.y, target);
    }
    case "debug-report":
      return {
        peek,
        interactive,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        shift: { x: Math.round(shift.x), y: Math.round(shift.y) },
        paused,
        state: brain.state,
        base: brain.base,
        expression: brain.face.expression,
        clip: brain.clips.name,
        indicator: brain.indicator,
        bubble: bubble.classList.contains("hidden") ? null : bubbleText.textContent,
        bubbleButtons: !bubbleActions.classList.contains("hidden"),
        voiceState,
        watchingPointer: brain.watchingPointer,
        attn: brain.attentionDebug,
        pose: brain.pose,
        gaze: { x: Math.round(brain.face.face.lookX * 100) / 100, y: Math.round(brain.face.face.lookY * 100) / 100 },
        speaking: speaker.speaking,
        listening: recorder.active,
        activity: brain.activity,
        mood: brain.mood,
        focus: brain.focus,
        walking: brain.walking,
        bpm: brain.bpm,
        beatPhase: brain.beatPhase,
        clock: brain.now,
        effects: fx.active,
        badge: fx.badgeEmoji,
        groove: Math.round(brain.groove * 100) / 100,
        gazeCentre: activityLook,
        chirp: lastChirp ? { kind: lastChirp.kind, msAgo: Math.round(performance.now() - lastChirp.at) } : null,
        chime: lastChime ? { kind: lastChime.kind, msAgo: Math.round(performance.now() - lastChime.at) } : null,
      };
    case "contact-sheet":
      return contactSheet(c.images, c.labels, c.columns);
  }
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

async function contactSheet(images: string[], labels: string[], columns: number): Promise<string> {
  const { width, height } = layout.window;
  const loaded = await Promise.all(
    images.map((src) => new Promise<HTMLImageElement>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = src;
    })),
  );
  const cellW = width;
  const cellH = height + 24;
  const rows = Math.ceil(loaded.length / columns);
  const sheet = document.createElement("canvas");
  sheet.width = cellW * columns;
  sheet.height = cellH * rows;
  const ctx = sheet.getContext("2d")!;
  ctx.fillStyle = "#20262c";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  loaded.forEach((img, i) => {
    const x = (i % columns) * cellW;
    const y = Math.floor(i / columns) * cellH;
    ctx.drawImage(img, x, y, cellW, height);
    ctx.fillStyle = "#e8edf1";
    ctx.font = "600 15px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText(labels[i] ?? "", x + cellW / 2, y + height + 17);
  });
  return sheet.toDataURL("image/png");
}

// ------------------------------------------------------------------ tray icon

function trayIcon(): string {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const t = THEMES[config.theme];
  ctx.fillStyle = t.shell;
  ctx.beginPath();
  ctx.roundRect(4, 8, 56, 50, 13);
  ctx.fill();
  ctx.fillStyle = "#0a0d10";
  ctx.beginPath();
  ctx.roundRect(10, 14, 44, 34, 8);
  ctx.fill();
  ctx.fillStyle = t.eyes;
  ctx.shadowColor = t.eyes;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.roundRect(19, 21, 9, 13, 3);
  ctx.roundRect(36, 21, 9, 13, 3);
  ctx.fill();
  return c.toDataURL("image/png");
}

// ---------------------------------------------------------------------- start

// The battery: low and unplugged makes it tired; plugging in perks it up (main/mood.ts).
void (async () => {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (e: string, f: () => void) => void }> };
    const b = await nav.getBattery?.();
    if (!b) return;
    const report = () => api.battery(b.level, b.charging);
    b.addEventListener("levelchange", report);
    b.addEventListener("chargingchange", report);
    report();
  } catch {
    /* no battery (desktop PC): energy just follows the time of day */
  }
})();

requestAnimationFrame(frame);
api.setTrayIcon(trayIcon());
api.ready();
brain.setState("happy"); // hello!
