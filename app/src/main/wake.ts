// wake.ts — "Hey Bit": hands-free voice commands.
//
// The listening itself happens in the backend (backend/wake.py), on this
// laptop: audio is processed in memory and never saved or sent. This module
// keeps it in step with the app:
//   - on only while the setting is on (off by default), and closed entirely
//     while the screen is locked or the laptop sleeps
//   - muted while the robot is talking (so it can't wake itself) or while
//     push-to-talk is recording
//   - re-applied whenever the backend (re)starts
//   - runs the command it hears like a spoken message

import type { BackendEvent } from "../shared/types";
import type { Backend } from "./backend";
import { log } from "./log";
import { musicOnWake } from "./musicHold";
import { endPeek, isPeeking, onPauseChange } from "./presence";
import { getSettings } from "./settings";

interface WakeStatus {
  enabled: boolean;
  listening: boolean;
  muted: boolean;
  error: string | null;
}

let getBackend: () => Backend | null = () => null;
let runCommand: (text: string) => void = () => undefined;
let onChange: () => void = () => undefined;
let paused = false;
let muted = false;
let status: WakeStatus | null = null;

export function startWake(backend: () => Backend | null, run: (text: string) => void, changed: () => void): void {
  getBackend = backend;
  runCommand = run;
  onChange = changed;
  onPauseChange((on) => {
    paused = on;
    void syncWake();
  });
}

/** Push on/off, name and muted to the backend (index.ts also calls this whenever the backend (re)starts). */
export async function syncWake(): Promise<void> {
  const backend = getBackend();
  if (!backend?.ready) return;
  const enabled = getSettings().wakeWord && !paused;
  const res = await backend.send<WakeStatus>("/wake", "POST", { enabled, muted, name: getSettings().name, quality: getSettings().sttQuality });
  status = res.ok ? res.data : null;
  if (enabled && status?.error) log("wake word:", status.error);
  onChange();
}

/** Muted while the robot speaks or push-to-talk records. */
export function setWakeMuted(on: boolean): void {
  if (on === muted) return;
  muted = on;
  if (getSettings().wakeWord) void getBackend()?.send("/wake", "POST", { muted: on });
}

/** Is the microphone open for the wake word right now? */
export function wakeListening(): boolean {
  return !!status?.listening && getSettings().wakeWord && !paused;
}

/** One line for the Settings panel. */
export function wakeNote(): string {
  const name = getSettings().name;
  if (!getSettings().wakeWord) return "Off — the microphone is only on when you press the mic or shortcut";
  if (status?.error) return status.error;
  if (paused) return "Paused while the screen is locked";
  if (status?.listening) return `Listening for “Hey ${name}” — on this laptop only, nothing is recorded or sent`;
  return "Starting…";
}

/** Wake events from the backend (the robot window gets them too, for its face). */
export async function handleWakeEvent(event: BackendEvent): Promise<void> {
  if (event.type !== "wake") return;
  musicOnWake(event.phase); // sure it's its name: the backend has paused the music
  if (event.phase === "listening" && isPeeking()) await endPeek();
  if (event.phase === "command" && event.text.trim()) {
    if (isPeeking()) await endPeek();
    log("wake word command");
    runCommand(event.text.trim().slice(0, 2000));
  }
}
