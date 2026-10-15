// Types shared by the main process, the preload bridge and the robot renderer.

export type RobotStateName =
  | "idle"
  | "happy"
  | "curious"
  | "listening"
  | "thinking"
  | "speaking"
  | "sleepy"
  | "surprised"
  | "excited"
  | "working"
  | "notification"
  | "peeking";

export const ROBOT_STATES: RobotStateName[] = [
  "idle", "happy", "curious", "listening", "thinking", "speaking",
  "sleepy", "surprised", "excited", "working", "notification", "peeking",
];

export type ClipName =
  | "bounce" | "hop" | "jump" | "tilt" | "spin" | "backflip"
  | "startle" | "wobble" | "nod" | "stretch" | "shake" | "land"
  | "lookback" | "shiver" | "dance" | "doublehop" | "bow" | "dizzy"
  | "sneeze" | "peer" | "yawn" | "wiggle" | "shrug" | "walk";

export const CLIPS: ClipName[] = [
  "bounce", "hop", "jump", "tilt", "spin", "backflip",
  "startle", "wobble", "nod", "stretch", "shake", "land",
  "lookback", "shiver", "dance", "doublehop", "bow", "dizzy",
  "sneeze", "peer", "yawn", "wiggle", "shrug", "walk",
];

/** Per-play variation, so the same move never looks quite the same twice. */
export interface ClipOptions {
  /** Playback speed multiplier (1 = as authored). */
  speed?: number;
  /** Size of the motion (1 = as authored). */
  amp?: number;
  /** -1 mirrors left/right (sideways lean, turn and spin direction). */
  mirror?: 1 | -1;
}

export type ExpressionName =
  | "neutral" | "happy" | "curious" | "sleepy" | "surprised" | "focused"
  | "excited" | "listening" | "thinking" | "alert" | "content" | "squint" | "wink";

export const EXPRESSIONS: ExpressionName[] = [
  "neutral", "happy", "curious", "sleepy", "surprised", "focused",
  "excited", "listening", "thinking", "alert", "content", "squint", "wink",
];

export type Urgency = "low" | "normal" | "high";

/** Pushed by the Python backend over its WebSocket, forwarded by main. */
export interface BackendEvent {
  type: "reminder" | "info" | "status" | "wake" | "activity" | "beat";
  text: string;
  /** Wake word: maybe its name (perk up) / sure it was (chime, listen) / the command to run / nothing followed. */
  phase?: "attention" | "listening" | "command" | "cancel";
  /** Wake word "listening": you're still talking (so no chime on top of your words). */
  speaking?: boolean;
  /** Activity: what you're doing, and whether a song is playing. */
  activity?: "none" | "coding" | "watching" | "music";
  music?: boolean;
  /** Activity (added by main): where to rest the eyes, e.g. towards the video. */
  look?: [number, number];
  /** Beat: the song's tempo (0 = no steady beat) and when the next beat lands. */
  bpm?: number;
  next_beat_ms?: number;
  urgency?: Urgency;
  /** Reminders: which task occurrence it's about (enables Done / Snooze). */
  item_id?: number;
  occurrence?: string;
  kind?: string;
  title?: string;
}

/** One occurrence of a task on a given day (repeating tasks have many). */
export interface Occurrence {
  item_id: number;
  title: string;
  notes: string | null;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM, null = any time that day
  repeat: string | null; // RRULE
  repeat_text: string; // "every weekday", "once"
  done: boolean;
  occurrence: string;
  /** A Google Calendar event (read-only in the Today tab). */
  calendar?: boolean;
  location?: string;
}

export interface CalendarStatus {
  connected: boolean;
  connecting: boolean;
  set_up: boolean;
  error: string | null;
}

export interface NewTask {
  title: string;
  date: string;
  time: string | null;
  repeat: string | null;
}

export type ThemeName = "ivory-cyan" | "silver-purple";

/** Commands main sends to the robot (tray menu, second launch, self-test). */
export type RobotCommand =
  | { kind: "state"; state: RobotStateName }
  | { kind: "clip"; clip: ClipName }
  | { kind: "say"; text: string; urgency?: Urgency }
  | { kind: "theme"; theme: ThemeName }
  | { kind: "speak-enabled"; enabled: boolean }
  | { kind: "greet"; text: string }
  // Edge peeking (main moves the window; the robot slides in/out of the edge)
  | { kind: "can-peek" }
  | { kind: "peek-prepare"; edge: Edge }
  | { kind: "peek-enter"; edge: Edge }
  | { kind: "peek-exit" }
  | { kind: "user-idle"; sleepy: boolean }
  | { kind: "pause"; on: boolean }
  | { kind: "layout"; size: RobotSize }
  // Voice
  | {
      kind: "reply";
      say: string;
      mood: Mood;
      bubble: boolean;
      /** played once it finishes talking, instead of the usual mood reaction */
      clip?: ClipName;
      /** show it, don't speak it (music commands) */
      quiet?: boolean;
      /** conversation: listen for the answer when done, no wake word needed */
      listenAfter?: boolean;
      /** keep a thinking face after speaking (it's looking something up) */
      thenThink?: boolean;
    }
  | { kind: "listen-toggle" }
  | { kind: "stop-speaking" }
  | { kind: "voice"; voice: string }
  | { kind: "test-voice" }
  // Where your mouse pointer is relative to the robot's centre (DIPs), for eye-following.
  | { kind: "attention"; dx: number; dy: number; dist: number; over: boolean; closing: number }
  | { kind: "follow-mouse"; enabled: boolean }
  | { kind: "sounds"; on: boolean }
  | { kind: "mood"; mood: MoodName; energy: number }
  | { kind: "focus"; on: boolean }
  /** Bit is looking at your screen ("help me with this" and follow-ups): the 👀 badge. */
  | { kind: "looking"; on: boolean }
  /** What it heard was background talk, not a request: the "hm?" look and a soft chime, no voice. */
  | { kind: "ignored" }
  | { kind: "walk"; on: boolean; dir?: 1 | -1 }
  | { kind: "effect"; effect: "confetti" | "sparkle" | "heart" | "note" | "z" | "star" }
  | { kind: "badge"; emoji: string | null; label: string }
  | { kind: "activity"; activity: "none" | "coding" | "watching" | "music"; music: boolean; look: [number, number] }
  // Self-test only: hold a pose so it can be captured deterministically.
  | { kind: "freeze"; state?: RobotStateName; expression?: ExpressionName; clip?: ClipName; t?: number; lookX?: number; lookY?: number }
  | { kind: "unfreeze" }
  | { kind: "debug-backdrop"; on: boolean }
  | { kind: "debug-hover"; x: number; y: number }
  | { kind: "debug-report" }
  | { kind: "contact-sheet"; images: string[]; labels: string[]; columns: number };

export interface CommandEnvelope {
  id: number;
  command: RobotCommand;
}

export type Mood = "happy" | "curious" | "thinking" | "surprised" | "excited" | "neutral" | "sleepy";

export interface ChatResult {
  ok: boolean;
  reply?: string;
  say?: string;
  details?: string | null;
  mood?: Mood;
  applied?: boolean;
  /** A YouTube page to open in the browser ("play lofi"); checked again by links.ts. */
  open_url?: string | null;
  /** A task done without talking over the music: show it, don't speak it. */
  quiet?: boolean;
  /** "Let me look that up": the app asks the backend's /search for the answer next. */
  search?: { query: string; question: string } | null;
  /** "Help me with this": the app takes a screenshot and asks the backend's /look next. */
  look?: { question: string } | null;
  /** Looking at your screen: true = keep looking (a screenshot with each message), false = stop. */
  screen_mode?: boolean | null;
  /** Background talk (a video, other people), not a request: stay quiet. */
  ignored?: boolean;
  /** Facts about you it saved this turn (long-term memory), shown under the reply. */
  remembered?: string[];
  /** The conversation (thread) this turn belongs to. */
  thread_id?: string;
  /** A trick you asked for ("do a backflip"): played after it speaks. */
  move?: ClipName | null;
  /** Start ({minutes}) or stop ({stop: true}) the focus timer. */
  focus?: { minutes?: number; stop?: boolean } | null;
  /** Something was added to Google Calendar (refresh the Today tab). */
  calendar_changed?: boolean;
  /** The action that was applied (e.g. {type: "complete"}: confetti). */
  action?: { type?: string } | null;
  /** The reply expects an answer (a question, or chatting): keep the conversation going. */
  follow_up?: boolean;
  offline?: boolean;
  error?: string;
}

/** Bit's mood (main/mood.ts). */
export type MoodName = "playful" | "happy" | "content" | "bored" | "lonely" | "tired";
export interface MoodState {
  name: MoodName;
  happiness: number;
  boredom: number;
  energy: number;
  battery: { level: number; charging: boolean } | null;
}

/** A conversation ("New chat"). */
export interface Thread {
  id: string;
  title: string;
  current: boolean;
  updated_at: string;
}

/** Something Bit remembers about you (long-term memory). */
export interface Fact {
  key: string;
  fact: string;
  updated_at: string;
}

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  text: string;
  details?: string | null;
  source?: string | null;
  created_at?: string;
}

export interface Task {
  id: number;
  title: string;
  task_date: string;
  start_time: string;
  end_time: string | null;
  priority: string;
  done: number;
}

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

/** fast / accurate run locally; online sends just the spoken command to Groq (better with names). */
export type SttQuality = "fast" | "accurate" | "online";

export interface PanelSettings {
  name: string;
  speak: boolean;
  voice: string;
  sttQuality: SttQuality;
  size: RobotSize;
  theme: ThemeName;
  followMouse: boolean;
  wakeWord: boolean;
  followActivity: boolean;
  sounds: boolean;
  checkIns: boolean;
  wander: boolean;
  /** Read-only, from main: what hands-free listening is doing ("Listening for “Hey Bit”", or a problem). */
  wakeNote?: string;
}

export interface PanelData {
  settings: PanelSettings;
  history: ChatMessage[];
  tasks: Task[];
  backendReady: boolean;
  voices: string[];
  listenShortcut: string;
  voiceState: VoiceState;
  mood?: MoodName;
  focus?: string | null;
  /** Bit is looking at your screen (the header says so). */
  looking?: boolean;
}

/** Things main pushes to the chat panel. */
export type PanelEvent =
  | { type: "user"; text: string; source: "typed" | "voice" }
  | { type: "assistant"; text: string; details?: string | null; offline?: boolean; remembered?: string[] }
  | { type: "threads-changed" }
  | { type: "mood"; mood: MoodName }
  | { type: "focus"; label: string | null }
  | { type: "looking"; on: boolean }
  | { type: "voice-state"; state: VoiceState }
  | { type: "tasks-changed" }
  | { type: "settings"; settings: PanelSettings }
  | { type: "history-cleared" };

/** Initial config handed to the renderer. */
export interface RobotConfig {
  name: string;
  theme: ThemeName;
  speak: boolean;
  selftest: boolean;
  size: RobotSize;
  voice: string;
  followMouse: boolean;
}

export type Edge = "left" | "right" | "bottom";

// ------------------------------------------------------------------ layout
// Everything size-dependent comes from layoutFor(), so the robot can be made
// smaller or larger. The window shrinks with the robot (less screen covered),
// but never below what the speech bubble needs.

export type RobotSize = "small" | "medium" | "large";
export const SIZE_SCALE: Record<RobotSize, number> = { small: 0.62, medium: 0.8, large: 1 };

export interface Layout {
  scale: number;
  /** Window size, DIPs. */
  window: { width: number; height: number };
  /** Robot centre inside the window. */
  anchor: { x: number; y: number };
  /** Box around the robot that must stay on screen. */
  box: { x: number; y: number; width: number; height: number };
  /** Robot size on screen: px per scene unit (the body is 1.24 units wide). */
  pxPerUnit: number;
  /** Speech bubble: distance of its bottom from the window bottom, and max width. */
  bubbleBottom: number;
  bubbleMax: number;
  /**
   * Peeking: the window sits flush against a screen edge and the robot slides
   * this many px (dx, dy) towards it, so the window boundary — and with it the
   * screen edge — cuts it off. "far" is a bolder peek.
   */
  peek: Record<Edge, { hidden: [number, number]; far: [number, number] }>;
}

export function layoutFor(size: RobotSize): Layout {
  const s = SIZE_SCALE[size];
  const width = Math.max(Math.round(300 * s), 236);
  const height = Math.max(Math.round(360 * s), 280);
  const anchor = { x: Math.round(width / 2), y: height - Math.round(98 * s) };
  const box = {
    x: Math.round(anchor.x - 70 * s),
    y: Math.round(anchor.y - 66 * s),
    width: Math.round(140 * s),
    height: Math.round(134 * s),
  };
  const side = width / 2;
  const below = height - anchor.y;
  return {
    scale: s,
    window: { width, height },
    anchor,
    box,
    pxPerUnit: 105.4 * s,
    bubbleBottom: height - box.y + 8,
    bubbleMax: width - 24,
    peek: {
      right: { hidden: [Math.round(side + 18 * s), 0], far: [Math.round(side - 34 * s), 0] },
      left: { hidden: [-Math.round(side + 18 * s), 0], far: [-Math.round(side - 34 * s), 0] },
      bottom: { hidden: [0, Math.round(below - 2 * s)], far: [0, Math.round(below - 34 * s)] },
    },
  };
}

/** How the robot leans and looks while peeking from each edge (size-independent). */
export const PEEK_STYLE: Record<Edge, { lean: { ry: number; rz: number }; look: [number, number] }> = {
  right: { lean: { ry: -0.45, rz: 0.1 }, look: [-0.75, 0.05] },
  left: { lean: { ry: 0.45, rz: -0.1 }, look: [0.75, 0.05] },
  bottom: { lean: { ry: 0, rz: 0 }, look: [0, -0.7] },
};
