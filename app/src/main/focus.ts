// focus.ts — a Pomodoro focus timer. "Focus for 25 minutes" (or the tray):
// Bit goes quiet and focused (calm moves, a 🍅 badge, no check-ins), the chat
// panel shows the time left, and at the end it celebrates and starts a break
// (5 minutes; 15 after every fourth session). "Stop the timer" cancels.

import { sendCommand } from "./commands";
import { log } from "./log";
import { moodEvent } from "./mood";
import { sendToPanel } from "./panelWindow";

export interface FocusSession {
  kind: "focus" | "break";
  minutes: number;
  endsAt: number;
}

let session: FocusSession | null = null;
let doneToday = 0;
let doneDay = "";
let timer: NodeJS.Timeout | null = null;
let onChange: () => void = () => undefined;

const MAX_MINUTES = 180;

export function startFocusTimer(changed: () => void): void {
  onChange = changed;
}

export function focusSession(): FocusSession | null {
  return session;
}

/** Focus (not a break): check-ins stay quiet. */
export function isFocusing(): boolean {
  return session?.kind === "focus";
}

export function minutesLeft(now = Date.now()): number {
  return session ? Math.max(0, Math.ceil((session.endsAt - now) / 60_000)) : 0;
}

/** For the panel header and the tray: "Focus · 18 min left". */
export function focusLabel(now = Date.now()): string | null {
  if (!session) return null;
  return `${session.kind === "focus" ? "Focus" : "Break"} · ${minutesLeft(now)} min left`;
}

/** A few words for the AI ("a focus session, 18 minutes left"). */
export function focusForPrompt(): string {
  if (!session) return "";
  return `${session.kind === "focus" ? "A focus session is running" : "A break is running"}: ${minutesLeft()} minutes left (${doneToday} focus session${doneToday === 1 ? "" : "s"} done today).`;
}

export function startFocus(minutes = 25, kind: "focus" | "break" = "focus"): FocusSession {
  const m = Math.max(0.05, Math.min(MAX_MINUTES, minutes));
  session = { kind, minutes: m, endsAt: Date.now() + m * 60_000 };
  log(`${kind} started: ${m} min`);
  void sendCommand({ kind: "focus", on: kind === "focus" });
  ensureTimer();
  changed();
  return session;
}

export function stopFocus(): boolean {
  if (!session) return false;
  session = null;
  void sendCommand({ kind: "focus", on: false });
  changed();
  return true;
}

function changed(): void {
  sendToPanel({ type: "focus", label: focusLabel() });
  onChange();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!session) return;
    if (Date.now() >= session.endsAt) void finish();
    else sendToPanel({ type: "focus", label: focusLabel() });
  }, 2000);
}

async function finish(): Promise<void> {
  const ended = session;
  if (!ended) return;
  session = null;
  void sendCommand({ kind: "focus", on: false });
  if (ended.kind === "focus") {
    const today = new Date().toDateString();
    if (doneDay !== today) {
      doneDay = today;
      doneToday = 0;
    }
    doneToday++;
    moodEvent("task");
    const long = doneToday % 4 === 0;
    const text = `Focus session done! That's ${doneToday} today. Take a ${long ? "15" : "5"}-minute break.`;
    sendToPanel({ type: "assistant", text, details: null });
    await sendCommand({ kind: "reply", say: text, mood: "happy", bubble: true });
    void sendCommand({ kind: "effect", effect: "confetti" });
    startFocus(long ? 15 : 5, "break");
  } else {
    const text = "Break's over! Ready for another round?";
    sendToPanel({ type: "assistant", text, details: null });
    await sendCommand({ kind: "reply", say: text, mood: "happy", bubble: true });
    changed();
  }
}
