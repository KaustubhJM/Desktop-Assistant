// robotWindow.ts — the small transparent window the robot lives in.
//
// - Click-through by default; the renderer switches clicks on while the
//   mouse is over the robot (or its bubble/input). Mouse moves are still
//   forwarded so the renderer can tell.
// - Custom dragging: while a drag is active, the window follows the cursor
//   (polled here, so a fast flick can't outrun it).
// - The robot itself (the layout's box) is always kept inside some display's work
//   area: on start, after a drag, and whenever displays change.

import { BrowserWindow, Display, Point, Rectangle, screen } from "electron";
import path from "path";
import type { Layout } from "../shared/types";
import { log } from "./log";
import { currentLayout, getSettings, updateSettings } from "./settings";

const EDGE_MARGIN = 8;

let win: BrowserWindow | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let dragOffset: Point = { x: 0, y: 0 };
let dragStartedAt = 0;
let screenHooked = false;

/** Swappable for the self-test, which can't move the real mouse. */
let cursorSource: () => Point = () => screen.getCursorScreenPoint();
export function setCursorSource(fn: () => Point): void {
  cursorSource = fn;
}

/** Where the mouse pointer is (screen DIPs). */
export function getCursorPoint(): Point {
  return cursorSource();
}

export function getRobotWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function createRobotWindow(): BrowserWindow {
  const settings = getSettings();
  const pos = settings.position ? clampToDisplays(settings.position) : defaultPosition();

  win = new BrowserWindow({
    width: currentLayout().window.width,
    height: currentLayout().window.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    title: settings.name,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Reminders and greetings must be audible without a click first.
      autoplayPolicy: "no-user-gesture-required",
      // Keep animating even when Windows says the window is covered (e.g. a
      // full-screen video): otherwise Chromium slows it down and reactions
      // like "Hey Bit" show up late or not at all.
      backgroundThrottling: false,
    },
  });

  // Windows can round the size by a pixel when creating the window at
  // fractional scaling; pin it to the exact layout size.
  moveWindow(win, pos.x, pos.y);
  setClickThrough(true);
  win.once("ready-to-show", () => win?.showInactive());

  // Page errors go to logs/main.log, so a broken robot is diagnosable.
  win.webContents.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") log(`renderer ${details.level}: ${details.message}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => log("renderer gone:", details.reason));

  // Never let the page navigate away or open windows.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    win = null;
  });

  if (!screenHooked) {
    screenHooked = true;
    for (const event of ["display-added", "display-removed", "display-metrics-changed"] as const) {
      screen.on(event as "display-added", () => displayChangeHandler());
    }
  }
  return win;
}

/**
 * Move the window, pinning its size. At fractional display scaling (e.g.
 * 125%) Windows can change a window's size by a pixel on each setPosition;
 * over a glide or a drag that adds up to visible clipping.
 */
export function moveWindow(w: BrowserWindow, x: number, y: number): void {
  const { width, height } = currentLayout().window;
  w.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

export function setClickThrough(enabled: boolean): void {
  // forward: true keeps mouse-move events flowing to the page while clicks pass through.
  getRobotWindow()?.setIgnoreMouseEvents(enabled, { forward: true });
}

export function setAlwaysOnTop(enabled: boolean): void {
  // "screen-saver" is the strongest level; onTop.ts keeps re-asserting it.
  getRobotWindow()?.setAlwaysOnTop(enabled, "screen-saver");
  updateSettings({ alwaysOnTop: enabled });
}

/** Monitors added/removed/rescaled. Peeking swaps this out to re-place itself. */
let displayChangeHandler: () => void = () => ensureVisible();
export function setDisplayChangeHandler(fn: () => void): void {
  displayChangeHandler = fn;
}

export function isDragging(): boolean {
  return dragTimer !== null;
}

let glide: { timer: NodeJS.Timeout; done: () => void } | null = null;

/** Smoothly move the window to `target` over `ms` (ease in-out). */
export function glideTo(target: Point, ms: number): Promise<void> {
  stopGlide();
  const w = getRobotWindow();
  if (!w) return Promise.resolve();
  const [x0, y0] = w.getPosition();
  const t0 = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const ww = getRobotWindow();
      const u = Math.min(1, (Date.now() - t0) / ms);
      const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      if (ww) moveWindow(ww, x0 + (target.x - x0) * e, y0 + (target.y - y0) * e);
      if (!ww || u >= 1) stopGlide();
    }, 16);
    glide = { timer, done: resolve };
  });
}

function stopGlide(): void {
  if (!glide) return;
  clearInterval(glide.timer);
  const done = glide.done;
  glide = null;
  done();
}

export function dragStart(): void {
  const w = getRobotWindow();
  if (!w) return;
  stopGlide();
  const cursor = cursorSource();
  const [x, y] = w.getPosition();
  dragOffset = { x: cursor.x - x, y: cursor.y - y };
  dragStartedAt = Date.now();
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const ww = getRobotWindow();
    // Safety net: a drag can't silently last forever if the release is lost.
    if (!ww || Date.now() - dragStartedAt > 60_000) return dragEnd();
    const c = cursorSource();
    moveWindow(ww, c.x - dragOffset.x, c.y - dragOffset.y);
  }, 16);
}

export function dragEnd(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  ensureVisible();
}

/** Clamp the robot back onto a display and remember where it is. */
export function ensureVisible(): void {
  const w = getRobotWindow();
  if (!w) return;
  const [x, y] = w.getPosition();
  const next = clampToDisplays({ x, y });
  if (next.x !== x || next.y !== y) moveWindow(w, next.x, next.y);
  updateSettings({ position: next });
}

/** Put the robot back in its default corner of the primary display. */
export function bringBack(): void {
  const w = getRobotWindow();
  if (!w) return;
  const pos = defaultPosition();
  moveWindow(w, pos.x, pos.y);
  if (!w.isVisible()) w.showInactive();
  updateSettings({ position: pos });
}

export function defaultPosition(): Point {
  const wa = screen.getPrimaryDisplay().workArea;
  const box = currentLayout().box;
  return {
    x: Math.round(wa.x + wa.width - (box.x + box.width) - 24),
    y: Math.round(wa.y + wa.height - (box.y + box.height) - 12),
  };
}

/**
 * Switch to a new size, keeping the robot's centre where it is on screen
 * (then clamped, in case the bigger window would push it off).
 */
export function applySize(from: Layout, to: Layout): void {
  const w = getRobotWindow();
  if (!w) return;
  const [x, y] = w.getPosition();
  const pos = clampToDisplays({ x: x + from.anchor.x - to.anchor.x, y: y + from.anchor.y - to.anchor.y }, undefined, to);
  w.setBounds({ x: pos.x, y: pos.y, width: to.window.width, height: to.window.height });
  updateSettings({ position: pos });
}

/**
 * Given a window top-left, return the nearest top-left that keeps the robot's
 * box fully inside the work area of the display it's (mostly) on.
 */
export function clampToDisplays(pos: Point, displays: Display[] = screen.getAllDisplays(), layout: Layout = currentLayout()): Point {
  const box = layout.box;
  const robot: Rectangle = { x: pos.x + box.x, y: pos.y + box.y, width: box.width, height: box.height };
  const centre = { x: robot.x + robot.width / 2, y: robot.y + robot.height / 2 };
  const target = displays.reduce((best, d) =>
    distanceToRect(centre, d.workArea) < distanceToRect(centre, best.workArea) ? d : best,
  );
  const wa = target.workArea;
  const rx = clamp(robot.x, wa.x + EDGE_MARGIN, wa.x + wa.width - robot.width - EDGE_MARGIN);
  const ry = clamp(robot.y, wa.y + EDGE_MARGIN, wa.y + wa.height - robot.height - EDGE_MARGIN);
  return { x: Math.round(rx - box.x), y: Math.round(ry - box.y) };
}

function distanceToRect(p: Point, r: Rectangle): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
