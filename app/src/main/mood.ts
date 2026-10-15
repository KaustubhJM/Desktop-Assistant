// mood.ts — Bit's feelings: happiness, boredom and energy, from how you treat
// it, the time of day and your battery. They make a mood (playful, happy,
// content, bored, lonely, tired) that changes what it does on its own
// (brain.ts), lightly colours how it talks (sent with each chat), and shows
// in the chat panel. Kept in settings, so it carries over restarts.

import { powerMonitor } from "electron";
import type { MoodName, MoodState } from "../shared/types";
import { sendCommand } from "./commands";
import { getSettings, updateSettings } from "./settings";

const TICK_MS = 60_000;
const AWAY_S = 15 * 60; // no keyboard/mouse this long = you're away (boredom doesn't grow)

export type MoodEvent = "chat" | "pet" | "click" | "task" | "plugged";

/** How much each thing you do lifts its spirits (and cures boredom). */
const LIFT: Record<MoodEvent, { happiness: number; boredom: number }> = {
  chat: { happiness: 0.08, boredom: -0.35 },
  pet: { happiness: 0.06, boredom: -0.15 },
  click: { happiness: 0.02, boredom: -0.1 },
  task: { happiness: 0.12, boredom: -0.1 },
  plugged: { happiness: 0.05, boredom: 0 },
};

let battery: { level: number; charging: boolean } | null = null;
let activity: "none" | "coding" | "watching" | "music" = "none";
let onChange: (m: MoodState) => void = () => undefined;
let timer: NodeJS.Timeout | null = null;

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Energy from the time of day and the battery (low battery = tired). */
export function energyFor(hour: number, bat: { level: number; charging: boolean } | null): number {
  // Winding down from 10 PM (calmer), tired after midnight (under moodName's 0.3).
  const byHour = hour >= 7 && hour < 11 ? 0.9 : hour >= 11 && hour < 17 ? 0.75 : hour >= 17 && hour < 22 ? 0.6 : hour >= 22 ? 0.4 : 0.25;
  if (bat && !bat.charging && bat.level < 0.2) return Math.min(byHour, 0.25);
  return byHour;
}

/** The mood these feelings add up to. */
export function moodName(m: { happiness: number; boredom: number; energy: number }): MoodName {
  if (m.energy < 0.3) return "tired";
  if (m.boredom > 0.75 && m.happiness < 0.5) return "lonely";
  if (m.boredom > 0.6) return "bored";
  if (m.happiness > 0.7 && m.energy > 0.6) return "playful";
  if (m.happiness > 0.65) return "happy";
  return "content";
}

/** One minute passing: boredom grows while you're here but ignoring it; happiness drifts back to normal. */
export function tick(m: { happiness: number; boredom: number }, idleSeconds: number, act: typeof activity): { happiness: number; boredom: number } {
  const away = idleSeconds >= AWAY_S;
  const busy = act === "coding" || act === "watching"; // you're busy: it gets bored more slowly
  const boredom = away ? m.boredom : clamp(m.boredom + (busy ? 0.004 : act === "music" ? 0.002 : 0.008));
  const towards = boredom > 0.6 ? 0.45 : 0.6;
  const happiness = clamp(m.happiness + (towards - m.happiness) * 0.02);
  return { happiness, boredom };
}

/** The hour it is (the self-test fixes it, so its results don't depend on when it runs). */
let hourNow = (): number => new Date().getHours();
export function setHourSource(fn: (() => number) | null): void {
  hourNow = fn ?? (() => new Date().getHours());
}

export function current(): MoodState {
  const s = getSettings().mood;
  const energy = energyFor(hourNow(), battery);
  const m = { happiness: s.happiness, boredom: s.boredom, energy };
  return { ...m, name: moodName(m), battery: battery ? { ...battery } : null };
}

function changed(): void {
  const m = current();
  void sendCommand({ kind: "mood", mood: m.name, energy: m.energy });
  onChange(m);
}

export function startMood(notify: (m: MoodState) => void): void {
  onChange = notify;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const before = current().name;
    const next = tick(getSettings().mood, powerMonitor.getSystemIdleTime(), activity);
    updateSettings({ mood: { ...next, at: Date.now() } });
    if (current().name !== before) changed();
  }, TICK_MS);
  changed();
}

/** Something you did (chatted, petted, clicked, finished a task, plugged in). */
export function moodEvent(e: MoodEvent): void {
  const s = getSettings().mood;
  const lift = LIFT[e];
  updateSettings({ mood: { happiness: clamp(s.happiness + lift.happiness), boredom: clamp(s.boredom + lift.boredom), at: Date.now() } });
  changed();
}

export function setBattery(level: number, charging: boolean): void {
  const wasCharging = battery?.charging;
  battery = { level: clamp(level), charging };
  if (charging && wasCharging === false) moodEvent("plugged");
  else changed();
}

export function setMoodActivity(a: typeof activity): void {
  activity = a;
}

/** A few words for the AI ("bored — nobody's talked to it for a while"). */
export function moodForPrompt(): string {
  const m = current();
  const why: Record<MoodName, string> = {
    playful: "playful and full of energy",
    happy: "happy",
    content: "content",
    bored: "a bit bored (nobody's talked to you for a while)",
    lonely: "lonely (you've been ignored for a long time; you're glad they're talking to you)",
    tired: m.battery && m.battery.level < 0.2 && !m.battery.charging ? "tired (the laptop battery is low)" : "tired (it's late)",
  };
  return why[m.name];
}
