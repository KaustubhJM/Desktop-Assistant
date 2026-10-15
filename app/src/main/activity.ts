// activity.ts — the robot matches what you're doing: focused while you code,
// happy while you watch something, dancing when a song plays.
//
// The backend (backend/activity.py) works it out from which app is in front
// and what's playing in Windows' media sessions, on this laptop; only a
// one-word label arrives here. Never the screen, never titles.

import { screen } from "electron";
import type { BackendEvent } from "../shared/types";
import type { Backend } from "./backend";
import { onPauseChange } from "./presence";
import { getRobotWindow } from "./robotWindow";
import { setMoodActivity } from "./mood";
import { setCheckinActivity } from "./checkins";
import { currentLayout, getSettings } from "./settings";

export type Activity = "none" | "coding" | "watching" | "music";

let getBackend: () => Backend | null = () => null;
let paused = false;
let current: { activity: Activity; music: boolean } = { activity: "none", music: false };

export function startActivity(backend: () => Backend | null): void {
  getBackend = backend;
  onPauseChange((on) => {
    paused = on;
    void syncActivity();
  });
}

/** On while the setting is on and the screen isn't locked (index.ts also calls this when the backend (re)starts). */
export async function syncActivity(): Promise<void> {
  const backend = getBackend();
  if (!backend?.ready) return;
  await backend.send("/activity", "POST", { enabled: getSettings().followActivity && !paused });
  if (!getSettings().followActivity) current = { activity: "none", music: false };
}

export function currentActivity(): Activity {
  return getSettings().followActivity ? current.activity : "none";
}

/** Watching or listening counts as being here: no hiding at the edge or dozing off mid-video. */
export function userIsWatchingOrListening(): boolean {
  return getSettings().followActivity && (current.activity === "watching" || current.activity === "music" || current.music);
}

/** Remember the latest label and add where the robot should look (watching: towards the middle of the screen). */
export function noteActivity(event: BackendEvent): BackendEvent {
  if (event.type !== "activity") return event;
  current = { activity: (event.activity ?? "none") as Activity, music: !!event.music };
  setMoodActivity(current.activity);
  setCheckinActivity(current.activity);
  return { ...event, look: event.activity === "watching" ? lookTowardsScreen() : [0, 0] };
}

function lookTowardsScreen(): [number, number] {
  const win = getRobotWindow();
  if (!win) return [0, 0];
  const [x, y] = win.getPosition();
  const box = currentLayout().box;
  const centre = { x: x + box.x + box.width / 2, y: y + box.y + box.height / 2 };
  const wa = screen.getDisplayNearestPoint(centre).workArea;
  const dx = (wa.x + wa.width / 2 - centre.x) / (wa.width / 2);
  const dy = (wa.y + wa.height / 2 - centre.y) / (wa.height / 2);
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  return [Math.round(clamp(dx, 1) * 0.7 * 100) / 100, Math.round(clamp(dy, 1) * 0.5 * 100) / 100];
}
