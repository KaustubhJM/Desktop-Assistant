// presence.ts — how the robot shares your desktop over time:
//   - peeks from a screen edge after you've been away a while, and comes
//     back out when you click it, a reminder fires, or you press the shortcut
//   - gets sleepy after a long idle stretch, wakes when you're back
//   - stops drawing while the screen is locked or the laptop sleeps
//   - launch at login, and a global "bring it back" shortcut
//
// Idle time is Windows' own "seconds since the last keyboard/mouse input"
// counter (powerMonitor.getSystemIdleTime). No input is recorded.

import { app, globalShortcut, powerMonitor, screen, type Point } from "electron";
import { layoutFor, type Edge, type RobotSize } from "../shared/types";
import { sendCommand } from "./commands";
import { chooseEdge, peekWindowPosition } from "./edges";
import { log } from "./log";
import { closePanel } from "./panelWindow";
import { applySize, clampToDisplays, ensureVisible, getCursorPoint, getRobotWindow, glideTo, isDragging, moveWindow, setDisplayChangeHandler } from "./robotWindow";
import { currentLayout, getSettings, updateSettings } from "./settings";
import { userIsWatchingOrListening } from "./activity";

export const RECOVER_SHORTCUT = "Control+Alt+B";
const TICK_MS = 2000;

let peekEdge: Edge | null = null;
let home: Point | null = null;
let transitioning = false;
let lastEmerge = 0;
let sleepy = false;
let tick: NodeJS.Timeout | null = null;
let onChange: () => void = () => undefined;
let paused = false;
let attentionTimer: NodeJS.Timeout | null = null;
let lastPointer = { x: NaN, y: NaN };
let lastPointerFar = false;
let lastDist = NaN;
const ATTENTION_MS = 100;

/** Swappable for the self-test, which can't make you go idle. */
let idleSource: () => number = () => powerMonitor.getSystemIdleTime();
export function setIdleSource(fn: () => number): void {
  idleSource = fn;
}

export function isPeeking(): boolean {
  return peekEdge !== null;
}

export function peekingEdge(): Edge | null {
  return peekEdge;
}

export function startPresence(changed: () => void): void {
  onChange = changed;
  setDisplayChangeHandler(handleDisplayChange);
  tick = setInterval(checkIdle, TICK_MS);
  attentionTimer = setInterval(attentionTick, ATTENTION_MS);

  powerMonitor.on("lock-screen", () => pause(true));
  powerMonitor.on("suspend", () => pause(true));
  powerMonitor.on("unlock-screen", () => pause(false));
  powerMonitor.on("resume", () => pause(false));

  if (!globalShortcut.register(RECOVER_SHORTCUT, () => void recover())) {
    log(`could not register ${RECOVER_SHORTCUT} (another app may own it)`);
  }
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (tick) clearInterval(tick);
    if (attentionTimer) clearInterval(attentionTimer);
  });
}

async function checkIdle(): Promise<void> {
  if (paused) return; // screen locked / asleep: nothing to react to, and the robot isn't drawing
  const s = getSettings();
  // Watching a video or listening to music without touching anything isn't "away".
  const idle = userIsWatchingOrListening() ? 0 : idleSource();

  const nowSleepy = idle >= s.sleepyAfterSeconds;
  if (nowSleepy !== sleepy) {
    sleepy = nowSleepy;
    void sendCommand({ kind: "user-idle", sleepy });
  }

  const rested = Date.now() - lastEmerge > s.peekAfterSeconds * 1000;
  if (s.peekEnabled && !peekEdge && !transitioning && !isDragging() && idle >= s.peekAfterSeconds && rested) {
    if (await sendCommand<boolean>({ kind: "can-peek" })) await startPeek();
  }
}

/** Slide to the nearest suitable screen edge and peek. */
export async function startPeek(edge?: Edge): Promise<boolean> {
  const win = getRobotWindow();
  if (!win || peekEdge || transitioning || isDragging() || !win.isVisible()) return false;
  transitioning = true;
  try {
    closePanel();
    const [x, y] = win.getPosition();
    home = { x, y };
    const box = currentLayout().box;
    const centre = { x: x + box.x + box.width / 2, y: y + box.y + box.height / 2 };
    const display = screen.getDisplayNearestPoint(centre);
    const chosen = edge ?? chooseEdge(centre, display, screen.getAllDisplays());
    const target = peekWindowPosition(chosen, home, display.workArea, currentLayout());

    await sendCommand({ kind: "peek-prepare", edge: chosen });
    await glideTo(target, 1100);
    await sendCommand({ kind: "peek-enter", edge: chosen });
    peekEdge = chosen;
    log(`peeking from the ${chosen} edge`);
    return true;
  } finally {
    transitioning = false;
    onChange();
  }
}

/** Come back out to where the robot was before it peeked. */
export async function endPeek(): Promise<void> {
  if (!peekEdge || transitioning) return;
  transitioning = true;
  try {
    await sendCommand({ kind: "peek-exit" });
    const back = clampToDisplays(home ?? getDefaultHome());
    await glideTo(back, 900);
    peekEdge = null;
    lastEmerge = Date.now();
    updateSettings({ position: back });
    log("back from peeking");
  } finally {
    transitioning = false;
    onChange();
  }
}

/** Global shortcut / tray: make sure the robot is visible and reachable. */
export async function recover(): Promise<void> {
  const win = getRobotWindow();
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  if (peekEdge) await endPeek();
  else ensureVisible();
  void sendCommand({ kind: "state", state: "happy" });
  onChange();
}

/** While peeking, a monitor change re-places the robot on a valid edge. */
function handleDisplayChange(): void {
  const win = getRobotWindow();
  if (!win) return;
  if (!peekEdge) return ensureVisible();
  if (home) home = clampToDisplays(home);
  const [x, y] = win.getPosition();
  const box = currentLayout().box;
  const centre = { x: x + box.x + box.width / 2, y: y + box.y + box.height / 2 };
  const display = screen.getDisplayNearestPoint(centre);
  const edge = chooseEdge(centre, display, screen.getAllDisplays());
  const target = peekWindowPosition(edge, { x, y }, display.workArea, currentLayout());
  moveWindow(win, target.x, target.y);
  if (edge !== peekEdge) {
    peekEdge = edge;
    void sendCommand({ kind: "peek-enter", edge });
  }
}

function getDefaultHome(): Point {
  const [x, y] = getRobotWindow()?.getPosition() ?? [0, 0];
  return { x, y };
}

/**
 * Pointer awareness: ~10 times a second, tell the robot where the mouse
 * pointer is relative to its centre (only when it moved). Used only to
 * animate its eyes; nothing is recorded or sent anywhere else.
 */
function attentionTick(): void {
  const win = getRobotWindow();
  if (paused || !getSettings().followMouse || !win?.isVisible() || isDragging()) return;
  const c = getCursorPoint();
  const layout = currentLayout();
  const [x, y] = win.getPosition();
  const shift = peekEdge ? layoutFor(getSettings().size).peek[peekEdge].hidden : [0, 0];
  const dx = c.x - (x + layout.anchor.x + shift[0]);
  const dy = c.y - (y + layout.anchor.y + shift[1]);
  const dist = Math.hypot(dx, dy);
  // Approach speed (px/s) measured on this fixed clock, so a dash after a pause still counts as fast.
  const closing = Number.isFinite(lastDist) ? (lastDist - dist) / (ATTENTION_MS / 1000) : 0;
  lastDist = dist;
  if (c.x === lastPointer.x && c.y === lastPointer.y) return;
  lastPointer = c;
  if (dist > 900 && lastPointerFar) return; // far away: one update is enough
  lastPointerFar = dist > 900;
  void sendCommand({ kind: "attention", dx, dy, dist, over: dist < layout.box.width * 0.45, closing }, 1000);
}

let resumeListeners: (() => void)[] = [];
/** Called when the laptop wakes or the screen unlocks. */
export function onResume(fn: () => void): void {
  resumeListeners.push(fn);
}

let pauseListeners: ((on: boolean) => void)[] = [];
/** Called when the screen locks / laptop sleeps (true) and comes back (false). */
export function onPauseChange(fn: (on: boolean) => void): void {
  pauseListeners.push(fn);
}

function pause(on: boolean): void {
  paused = on;
  for (const fn of pauseListeners) fn(on);
  if (!on) for (const fn of resumeListeners) fn();
  log(on ? "screen locked / sleeping: pausing" : "back: resuming");
  void sendCommand({ kind: "pause", on });
}

/** Make the robot smaller or larger (tray → Size). */
export async function setSize(size: RobotSize): Promise<void> {
  if (size === getSettings().size) return;
  if (peekEdge) await endPeek();
  const from = currentLayout();
  updateSettings({ size });
  const to = currentLayout();
  // Resize the page first so the robot never renders squashed into the old window.
  await sendCommand({ kind: "layout", size });
  applySize(from, to);
  onChange();
}

// ------------------------------------------------------------- launch at login

function loginItemArgs(): string[] {
  // In development the app is run as `electron <app folder>`.
  return app.isPackaged ? [] : [app.getAppPath()];
}

export function setLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: loginItemArgs() });
  updateSettings({ launchAtLogin: enabled });
}

export function launchAtLoginEnabled(): boolean {
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
}
