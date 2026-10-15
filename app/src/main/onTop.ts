// onTop.ts — keep the robot (and its chat panel) above other windows.
//
// "Always on top" alone isn't enough on Windows: a full-screen Chromium
// browser (Brave/Chrome/Edge — YouTube full screen, F11) puts itself above
// always-on-top windows whenever it gets focus back, e.g. right after you
// click the robot and then the video again. The robot kept working but was
// buried. Reproduced with real windows and screenshots; re-asserting "on top"
// once a second (at the strongest level) is what reliably keeps it visible.

import { getPanelWindow } from "./panelWindow";
import { getRobotWindow, isDragging } from "./robotWindow";
import { getSettings } from "./settings";

const EVERY_MS = 1000;
let timer: NodeJS.Timeout | null = null;

export function startStayingOnTop(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(stayOnTop, EVERY_MS);
}

export function stopStayingOnTop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Put the robot back on top (no focus change), with the chat panel above it. */
export function stayOnTop(): void {
  if (!getSettings().alwaysOnTop) return;
  const robot = getRobotWindow();
  if (!robot || robot.isDestroyed() || !robot.isVisible() || isDragging()) return;
  robot.setAlwaysOnTop(true, "screen-saver");
  robot.moveTop();
  const panel = getPanelWindow();
  if (panel?.isVisible()) {
    panel.setAlwaysOnTop(true, "screen-saver");
    panel.moveTop();
  }
}
