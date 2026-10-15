// checkins.ts — Bit speaking up on its own, sparingly: a morning hello, a
// stretch break after long coding, a late-night nudge, a "deadline vs
// YouTube" nudge, and an end-of-day "nice work". At most one every 40
// minutes, only while you're at the laptop, never while it's talking or
// listening or during a focus session, and Settings → "Check-ins" turns
// them off. Each one is added to the conversation, so a reply makes sense.

import { powerMonitor } from "electron";
import type { Occurrence } from "../shared/types";
import type { Backend } from "./backend";
import { sendCommand } from "./commands";
import { log } from "./log";
import { sendToPanel } from "./panelWindow";
import { getSettings, updateSettings } from "./settings";

export type CheckinKind = "morning" | "stretch" | "latenight" | "deadline" | "evening";
type Activity = "none" | "coding" | "watching" | "music";

const TICK_MS = 60_000;
const GAP_MS = 40 * 60_000; // at most one check-in per 40 minutes
const PRESENT_S = 120; // you touched the keyboard/mouse in the last 2 minutes
const CODING_MIN = 90;
const WATCHING_MIN = 120;
const BREAK_MS = 5 * 60_000; // a gap shorter than this doesn't end a coding/watching stretch

export interface CheckinMemory {
  last: number; // last check-in of any kind (ms)
  morning: string; // the date (YYYY-MM-DD) each daily one last happened
  evening: string;
  latenight: string;
  deadline: number; // ms
}

/** How long you've been coding / watching, allowing short breaks. */
export class Stretch {
  since: number | null = null;
  private lastSeen = 0;
  update(on: boolean, now: number): void {
    if (on) {
      if (this.since === null || now - this.lastSeen > BREAK_MS) this.since = now;
      this.lastSeen = now;
    } else if (this.since !== null && now - this.lastSeen > BREAK_MS) {
      this.since = null;
    }
  }
  minutes(now: number): number {
    return this.since === null ? 0 : (now - this.since) / 60_000;
  }
  reset(now: number): void {
    this.since = now;
  }
}

export interface Situation {
  now: Date;
  idleSeconds: number;
  codingMinutes: number;
  watchingMinutes: number;
  busy: boolean; // talking, listening, or a focus session
  enabled: boolean;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Is it time for one? (Which one, by priority.) Tasks are checked afterwards (deadline, evening). */
export function decide(s: Situation, m: CheckinMemory): CheckinKind | null {
  if (!s.enabled || s.busy || s.idleSeconds > PRESENT_S) return null;
  const t = s.now.getTime();
  const h = s.now.getHours() + s.now.getMinutes() / 60;
  const today = ymd(s.now);
  if (h >= 6 && h < 12 && m.morning !== today) return "morning"; // the day's first hello isn't rate-limited
  if (t - m.last < GAP_MS) return null;
  if (h >= 1 && h < 4.5 && m.latenight !== today) return "latenight";
  if (s.codingMinutes >= CODING_MIN) return "stretch";
  if (s.watchingMinutes >= WATCHING_MIN && t - m.deadline > WATCHING_MIN * 60_000) return "deadline";
  if (h >= 21 && h < 23.5 && m.evening !== today) return "evening";
  return null;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** What to say (null: nothing worth saying after all, e.g. no deadline today). */
export function compose(kind: CheckinKind, info: { codingMinutes: number; dueSoon: Occurrence[]; doneToday: number; name: string }): { text: string; clip?: "stretch" | "yawn"; confetti?: boolean } | null {
  switch (kind) {
    case "stretch": {
      const span = info.codingMinutes >= 150 ? "over two hours" : info.codingMinutes >= 110 ? "almost two hours" : "an hour and a half";
      return { text: pick([`You've been coding for ${span}. Stretch your legs?`, `${span[0].toUpperCase()}${span.slice(1)} of code! Quick stretch and some water?`]), clip: "stretch" };
    }
    case "latenight":
      return { text: pick(["It's past 1 AM… maybe sleep soon? Your reminders are safe with me.", "Still up? It's really late. A good night's sleep makes tomorrow easier."]), clip: "yawn" };
    case "deadline": {
      const due = info.dueSoon[0];
      if (!due) return null;
      const when = due.date === ymd(new Date()) ? (due.time ? `today at ${due.time}` : "today") : "tomorrow";
      return { text: `That's two hours of videos… and “${due.title}” is due ${when}. Just saying!` };
    }
    case "evening":
      if (info.doneToday < 1) return null;
      return { text: info.doneToday === 1 ? "You finished a task today. Nice work!" : `You finished ${info.doneToday} things today. Nice work!`, confetti: true };
    case "morning":
      return null; // the backend writes the morning hello (weather, today's tasks, special days)
  }
}

// ------------------------------------------------------------------ running it

const coding = new Stretch();
const watching = new Stretch();
let activity: Activity = "none";
let getBackend: () => Backend | null = () => null;
let isBusy: () => boolean = () => false;
let timer: NodeJS.Timeout | null = null;

export function setCheckinActivity(a: Activity): void {
  activity = a;
}

export function startCheckins(backend: () => Backend | null, busy: () => boolean): void {
  getBackend = backend;
  isBusy = busy;
  if (timer) clearInterval(timer);
  timer = setInterval(() => void checkNow(), TICK_MS);
}

/** Will the morning hello run today? (Then the sign-in greeting stays quiet.) */
export function morningHelloPending(now = new Date()): boolean {
  const h = now.getHours();
  return getSettings().checkIns && h >= 6 && h < 12 && getSettings().checkinMemory.morning !== ymd(now);
}

export async function checkNow(now = new Date(), idleSeconds = powerMonitor.getSystemIdleTime()): Promise<CheckinKind | null> {
  const t = now.getTime();
  coding.update(activity === "coding", t);
  watching.update(activity === "watching", t);
  const memory = getSettings().checkinMemory;
  const kind = decide(
    { now, idleSeconds, codingMinutes: coding.minutes(t), watchingMinutes: watching.minutes(t), busy: isBusy(), enabled: getSettings().checkIns },
    memory,
  );
  if (!kind) return null;
  const backend = getBackend();
  if (!backend?.ready) return null;
  const remember = (patch: Partial<CheckinMemory>) => updateSettings({ checkinMemory: { ...getSettings().checkinMemory, ...patch } });

  let said: { text: string; details?: string | null; clip?: "stretch" | "yawn"; confetti?: boolean } | null = null;
  if (kind === "morning") {
    remember({ morning: ymd(now), last: t });
    const brief = await backend.send<{ say: string; details: string | null }>("/briefing", "POST", { name: getSettings().name });
    if (brief.ok && brief.data?.say) said = { text: brief.data.say, details: brief.data.details };
  } else {
    const items = (await backend.getJson<Occurrence[]>("/items?days=2")) ?? [];
    const today = ymd(now);
    const dueSoon = items.filter((o) => !o.done && o.date >= today).sort((a, b) => (a.date + (a.time ?? "99")).localeCompare(b.date + (b.time ?? "99")));
    said = compose(kind, { codingMinutes: coding.minutes(t), dueSoon, doneToday: items.filter((o) => o.done && o.date === today).length, name: getSettings().name });
    if (kind === "latenight") remember({ latenight: ymd(now) });
    if (kind === "evening") remember({ evening: ymd(now) });
    if (kind === "deadline") remember({ deadline: t });
    if (kind === "stretch") coding.reset(t);
    if (said) remember({ last: t });
  }
  if (!said) return null;
  log(`check-in: ${kind}`);
  // Into the conversation, so "yeah okay" afterwards makes sense to it.
  await backend.send("/conversation/note", "POST", { text: said.text, details: said.details ?? null });
  sendToPanel({ type: "assistant", text: said.text, details: said.details ?? null });
  await sendCommand({ kind: "reply", say: said.text, mood: "happy", bubble: true, clip: said.clip });
  if (said.confetti) void sendCommand({ kind: "effect", effect: "confetti" });
  return kind;
}
