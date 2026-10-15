// wander.ts — Bit moves around on its own now and then, so it feels alive:
//   stroll    a short walk along the bottom of the screen (stepping, facing the way it goes)
//   perch     climbs onto the title bar of the window you're using (not maximised,
//             room above it) and sits there; hops down if that window moves or closes
//   follow    with more than one screen, follows you to the one you've been using
// At most every 6–12 minutes, only when it's idle: never while you code, during
// a focus session, while it's talking/listening, peeking or being dragged.
// Settings → "Wander around". Where you last dragged it stays its home
// (Ctrl+Alt+B / "Move to corner" bring it back).

import { screen, type Rectangle } from "electron";
import type { Backend } from "./backend";
import { sendCommand } from "./commands";
import { log } from "./log";
import { getRobotWindow, glideTo, isDragging, clampToDisplays } from "./robotWindow";
import { currentLayout, getSettings } from "./settings";

const TICK_MS = 30_000;
const SPEED = 110; // DIPs per second when walking
const FOLLOW_AFTER_MS = 60_000;

export interface ForegroundWindow {
  x: number; // DIPs
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
  ours: boolean;
}

type Point = { x: number; y: number };

let getBackend: () => Backend | null = () => null;
let canWander: () => boolean = () => false;
let timer: NodeJS.Timeout | null = null;
let nextMoveAt = Date.now() + gap();
let perchedOn: Rectangle | null = null;
let otherDisplaySince: { id: number; at: number } | null = null;
let moving = false;

/** Swappable for the self-test (a test window instead of whatever you have open). */
let readForeground: () => Promise<ForegroundWindow | null> = async () => {
  const raw = await getBackend()?.getJson<ForegroundWindow | null>("/foreground");
  if (!raw) return null;
  const dip = screen.screenToDipRect(null, { x: raw.x, y: raw.y, width: raw.width, height: raw.height });
  return { ...raw, ...dip };
};
export function setForegroundSource(fn: typeof readForeground): void {
  readForeground = fn;
}

function gap(): number {
  return (6 + Math.random() * 6) * 60_000;
}

export function startWander(backend: () => Backend | null, allowed: () => boolean): void {
  getBackend = backend;
  canWander = allowed;
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), TICK_MS);
}

export function isWandering(): boolean {
  return moving;
}

/** Where the robot's feet should go to sit on a window's title bar (window position), or null if it can't. */
export function perchSpot(win: ForegroundWindow, displays = screen.getAllDisplays()): Point | null {
  const box = currentLayout().box;
  if (win.ours || win.maximized || win.fullscreen || win.width < 360 || win.height < 160) return null;
  const display = displays.find((d) => win.x + win.width / 2 >= d.bounds.x && win.x + win.width / 2 < d.bounds.x + d.bounds.width) ?? displays[0];
  const wa = display.workArea;
  if (win.y - box.height < wa.y + 4 || win.y > wa.y + wa.height - 80) return null; // no room above it / off the bottom
  // Sit a bit left of the middle, clear of the window's buttons on the right.
  const robotX = Math.round(win.x + win.width * 0.45 - box.width / 2);
  const robotY = Math.round(win.y - box.height + 4); // feet just on the edge
  return { x: robotX - box.x, y: robotY - box.y };
}

/** A short stroll along the bottom of the screen it's on. */
export function strollSpot(from: Point, rand = Math.random): Point {
  const box = currentLayout().box;
  const wa = screen.getDisplayNearestPoint({ x: from.x + box.x + box.width / 2, y: from.y + box.y + box.height / 2 }).workArea;
  const minX = wa.x + 16 - box.x;
  const maxX = wa.x + wa.width - box.width - 16 - box.x;
  let dist = (150 + rand() * 250) * (rand() < 0.5 ? -1 : 1);
  if (from.x + dist < minX || from.x + dist > maxX) dist = -dist;
  const y = wa.y + wa.height - box.height - 12 - box.y;
  return { x: Math.round(Math.max(minX, Math.min(maxX, from.x + dist))), y: Math.round(y) };
}

/** Walk (or hop up/down) to a window position, stepping all the way. */
export async function walkTo(target: Point): Promise<void> {
  const win = getRobotWindow();
  if (!win) return;
  const [x, y] = win.getPosition();
  const dir: 1 | -1 = target.x >= x ? 1 : -1;
  const dist = Math.hypot(target.x - x, target.y - y);
  moving = true;
  try {
    const climbing = Math.abs(target.y - y) > 40;
    if (climbing) await sendCommand({ kind: "clip", clip: "jump" }); // a hop up (or down) first
    await sendCommand({ kind: "walk", on: true, dir });
    await glideTo(clampToDisplays(target), Math.max(700, (dist / SPEED) * 1000));
  } finally {
    await sendCommand({ kind: "walk", on: false });
    if (Math.abs(target.y - y) > 40) void sendCommand({ kind: "clip", clip: "land" });
    moving = false;
  }
}

let perchedAt: Point | null = null;

export async function tick(now = Date.now(), prefer?: "perch" | "stroll"): Promise<string | null> {
  const win = getRobotWindow();
  if (!win || !win.isVisible() || moving || isDragging() || !getSettings().wander || !canWander()) return null;
  const fg = await readForeground().catch(() => null);
  const [x, y] = win.getPosition();

  // You moved it (dragged it, "Move to corner"): it's not up there any more.
  if (perchedOn && perchedAt && Math.hypot(x - perchedAt.x, y - perchedAt.y) > 30) {
    perchedOn = null;
    perchedAt = null;
  }

  // Perched, and that window moved or closed (or you switched away): hop down.
  if (perchedOn && (!fg || Math.abs(fg.x - perchedOn.x) > 8 || Math.abs(fg.y - perchedOn.y) > 8 || fg.width !== perchedOn.width)) {
    perchedOn = null;
    await walkTo(strollSpot({ x, y }));
    log("wander: hopped down");
    return "down";
  }

  // More than one screen: follow you to the one you've been using for a minute.
  const displays = screen.getAllDisplays();
  if (fg && !fg.ours && displays.length > 1) {
    const here = screen.getDisplayNearestPoint({ x: x + currentLayout().box.x, y: y + currentLayout().box.y }).id;
    const there = screen.getDisplayMatching({ x: fg.x, y: fg.y, width: fg.width, height: fg.height }).id;
    if (there !== here) {
      if (!otherDisplaySince || otherDisplaySince.id !== there) otherDisplaySince = { id: there, at: now };
      else if (now - otherDisplaySince.at >= FOLLOW_AFTER_MS) {
        otherDisplaySince = null;
        perchedOn = null;
        const d = displays.find((dd) => dd.id === there)!;
        const box = currentLayout().box;
        await walkTo({ x: d.workArea.x + d.workArea.width - box.width - 24 - box.x, y: d.workArea.y + d.workArea.height - box.height - 12 - box.y });
        log("wander: followed you to the other screen");
        return "follow";
      }
    } else otherDisplaySince = null;
  }

  if (!prefer && (now < nextMoveAt || perchedOn)) return null; // (a requested move doesn't wait)
  nextMoveAt = now + gap();
  const spot = fg ? perchSpot(fg) : null;
  if (spot && prefer !== "stroll" && (prefer === "perch" || Math.random() < 0.45)) {
    await walkTo(spot);
    perchedOn = { x: fg!.x, y: fg!.y, width: fg!.width, height: fg!.height };
    const [px, py] = win.getPosition();
    perchedAt = { x: px, y: py };
    log("wander: perched on your window");
    return "perch";
  }
  await walkTo(strollSpot({ x, y }));
  log("wander: strolled");
  return "stroll";
}

/** Why it won't move right now (for logs and the self-test). */
export function blockers(): string[] {
  const win = getRobotWindow();
  const why: string[] = [];
  if (!win) why.push("no window");
  else if (!win.isVisible()) why.push("hidden");
  if (moving) why.push("already moving");
  if (isDragging()) why.push("being dragged");
  if (!getSettings().wander) why.push("switched off");
  if (!canWander()) why.push("busy, peeking, focusing, coding or locked");
  return why;
}

/** Self-test: move now (skip the waiting). */
export function wanderNow(): void {
  nextMoveAt = 0;
}

export function wanderState(): { perched: boolean; moving: boolean } {
  return { perched: perchedOn !== null, moving };
}
