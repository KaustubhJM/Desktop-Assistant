// settings.ts — user settings, persisted as JSON in the app's userData folder.
// Writes are debounced and atomic (write to a temp file, then rename), so a
// crash mid-write can never leave a corrupt settings file behind.

import { app } from "electron";
import fs from "fs";
import path from "path";
import { layoutFor, type Layout, type RobotSize, type SttQuality, type ThemeName } from "../shared/types";

export interface Settings {
  name: string;
  theme: ThemeName;
  alwaysOnTop: boolean;
  /** Speak reminders and replies with the temporary Windows voice (real voice arrives in M3). */
  speak: boolean;
  /** Top-left of the robot window, in DIPs. Absent = default corner. */
  position?: { x: number; y: number };
  /** Override for the backend's Python interpreter. */
  pythonPath?: string;
  /** Slide to a screen edge and peek out when you're away. */
  peekEnabled: boolean;
  /** Seconds without keyboard/mouse input before peeking. */
  peekAfterSeconds: number;
  /** Seconds without input before getting sleepy. */
  sleepyAfterSeconds: number;
  /** Say hello once per Windows session. */
  greetOnLogin: boolean;
  /** Start automatically when you sign in to Windows. */
  launchAtLogin: boolean;
  /** How big the robot is on screen. */
  size: RobotSize;
  /** Kokoro voice for speech. */
  voice: string;
  /** Speech recognition: fast (base.en) or accurate (small.en). */
  sttQuality: SttQuality;
  /** The robot's eyes follow your mouse pointer when it's nearby. */
  followMouse: boolean;
  /** Hands-free: listen for "Hey <name>" (microphone stays on, processed locally). Off by default. */
  wakeWord: boolean;
  /** Match what you're doing (app in front + what's playing; read locally, never the screen). */
  followActivity: boolean;
  /** Little sounds: the listening chimes and robot chirps (not the voice). */
  sounds: boolean;
  /** Its feelings (mood.ts), kept across restarts. */
  mood: { happiness: number; boredom: number; at: number };
  /** Speaking up on its own now and then (checkins.ts). */
  checkIns: boolean;
  /** Moving around on its own now and then: strolls, perching on your window (wander.ts). */
  wander: boolean;
  /** When each check-in last happened (so a restart doesn't repeat today's). */
  checkinMemory: { last: number; morning: string; evening: string; latenight: string; deadline: number };
  /** Bumped when a default changes, so old saved defaults can be migrated. */
  settingsVersion: number;
}

const DEFAULTS: Settings = {
  name: "Bit",
  theme: "ivory-cyan",
  alwaysOnTop: true,
  speak: true,
  peekEnabled: true,
  peekAfterSeconds: 120,
  sleepyAfterSeconds: 900,
  greetOnLogin: true,
  launchAtLogin: false,
  size: "small",
  voice: "af_heart",
  sttQuality: "fast",
  followMouse: true,
  wakeWord: false,
  followActivity: true,
  sounds: true,
  mood: { happiness: 0.6, boredom: 0.2, at: 0 },
  checkIns: true,
  wander: true,
  checkinMemory: { last: 0, morning: "", evening: "", latenight: "", deadline: 0 },
  settingsVersion: 2,
};

/** v1 saved its defaults explicitly; move users still on an old default to the new one. */
function migrate(s: Settings): Settings {
  if ((s.settingsVersion ?? 1) < 2) {
    if (s.peekAfterSeconds === 300) s.peekAfterSeconds = DEFAULTS.peekAfterSeconds;
    s.settingsVersion = 2;
  }
  return s;
}

let current: Settings = { ...DEFAULTS };
let saveTimer: NodeJS.Timeout | null = null;

function filePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    current = migrate({ ...DEFAULTS, settingsVersion: 1, ...raw });
  } catch {
    current = { ...DEFAULTS }; // first run, or unreadable file: start fresh
  }
  return current;
}

export function getSettings(): Settings {
  return current;
}

/** Window/robot geometry for the current size setting. */
export function currentLayout(): Layout {
  return layoutFor(current.size);
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 300);
  return current;
}

export function flushSettings(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const target = filePath();
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error("Could not save settings:", err);
  }
}
