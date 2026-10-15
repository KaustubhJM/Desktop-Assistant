// panelWindow.ts — the compact chat panel that opens next to the robot.
// Created on demand and destroyed when closed, so it costs nothing while
// you're not using it.

import { BrowserWindow, screen } from "electron";
import path from "path";
import type { PanelEvent } from "../shared/types";
import { log } from "./log";
import { getRobotWindow } from "./robotWindow";
import { currentLayout, getSettings } from "./settings";

export const PANEL_SIZE = { width: 360, height: 500 };
const GAP = 10;

let panel: BrowserWindow | null = null;

export function getPanelWindow(): BrowserWindow | null {
  return panel && !panel.isDestroyed() ? panel : null;
}

export function isPanelOpen(): boolean {
  return !!getPanelWindow()?.isVisible();
}

export function togglePanel(): void {
  if (isPanelOpen()) closePanel();
  else openPanel();
}

export function closePanel(): void {
  // Forget it immediately: closing is asynchronous, and an open right after
  // must create a fresh panel rather than reuse the one that's going away.
  const closing = getPanelWindow();
  panel = null;
  closing?.close();
}

export function sendToPanel(event: PanelEvent): void {
  getPanelWindow()?.webContents.send("panel-event", event);
}

export function openPanel(): void {
  const existing = getPanelWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return;
  }
  const { x, y } = panelPosition();
  panel = new BrowserWindow({
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
    x,
    y,
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
    alwaysOnTop: getSettings().alwaysOnTop,
    title: `${getSettings().name} — chat`,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  panel.setBounds({ x, y, ...PANEL_SIZE }); // exact size at fractional scaling
  panel.webContents.on("will-navigate", (e) => e.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("console-message", (details) => {
    if (details.level === "error") log(`panel error: ${details.message}`);
  });
  const thisPanel = panel;
  panel.once("ready-to-show", () => {
    if (thisPanel.isDestroyed()) return;
    thisPanel.show();
    thisPanel.focus();
  });
  panel.on("closed", () => {
    if (panel === thisPanel) panel = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) panel.loadURL(`${process.env.ELECTRON_RENDERER_URL}/panel.html`);
  else panel.loadFile(path.join(__dirname, "../renderer/panel.html"));
}

/** Beside the robot: to its left if there's room, otherwise to its right. */
function panelPosition(): { x: number; y: number } {
  const robot = getRobotWindow();
  const box = currentLayout().box;
  const [rx, ry] = robot?.getPosition() ?? [0, 0];
  const robotRect = { x: rx + box.x, y: ry + box.y, width: box.width, height: box.height };
  const wa = screen.getDisplayNearestPoint({ x: robotRect.x, y: robotRect.y }).workArea;
  const { width, height } = PANEL_SIZE;

  let x = robotRect.x - width - GAP;
  if (x < wa.x + GAP) x = robotRect.x + robotRect.width + GAP;
  if (x + width > wa.x + wa.width - GAP) x = wa.x + wa.width - width - GAP;
  let y = robotRect.y + robotRect.height - height;
  y = Math.min(Math.max(y, wa.y + GAP), wa.y + wa.height - height - GAP);
  return { x: Math.round(x), y: Math.round(y) };
}
