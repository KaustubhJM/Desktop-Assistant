/**
 * "Help me with this": a screenshot of the screen you're working on (the one
 * with the mouse pointer), for the backend's /look (vision.py).
 *
 * Then Bit keeps looking while you talk about it: each message you send gets
 * a fresh screenshot (the backend's /chat answers with eyes), until you say
 * "stop looking", switch chats, or go quiet for a few minutes. A 👀 badge on
 * the robot and the chat header show it. Screenshots are only taken when you
 * say something.
 *
 * Bit and its chat window are left out of the picture: for the moment of the
 * capture they're marked "exclude from capture" (Windows 10 2004+), so the
 * picture shows what's underneath them. Only then; your own screenshots and
 * screen shares see Bit as usual.
 *
 * Only taken when you ask (or say something while it's looking), kept in
 * memory, sent with that one message, never saved.
 */

import { desktopCapturer, screen, type BrowserWindow } from "electron";
import { sendCommand } from "./commands";
import { getPanelWindow, sendToPanel } from "./panelWindow";
import { getRobotWindow } from "./robotWindow";

/** Wide enough to read code and small error text; small enough to send quickly. */
const MAX_WIDTH = 1920;
const JPEG_QUALITY = 85;

export interface Screenshot {
  image: string; // base64
  mime: "image/jpeg";
  width: number;
  height: number;
}

async function capture(): Promise<Screenshot | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const own = [getRobotWindow(), getPanelWindow()].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
  for (const w of own) w.setContentProtection(true);
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    let img = source.thumbnail;
    if (img.getSize().width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, quality: "best" });
    const { width, height } = img.getSize();
    return { image: img.toJPEG(JPEG_QUALITY).toString("base64"), mime: "image/jpeg", width, height };
  } catch {
    return null;
  } finally {
    for (const w of own) if (!w.isDestroyed()) w.setContentProtection(false);
  }
}

let grabber: () => Promise<Screenshot | null> = capture;

/** The screenshot, or null if Windows wouldn't give one. */
export function grabScreen(): Promise<Screenshot | null> {
  return grabber();
}

/** The self-test swaps in a fixed picture (and can still call the real one). */
export function setScreenGrabber(fn: (() => Promise<Screenshot | null>) | null): void {
  grabber = fn ?? capture;
}

export { capture as captureScreen };

// ------------------------------------------------------------ keep looking

/** Quiet this long and it stops looking. */
export const LOOKING_IDLE_MS = 3 * 60_000;
let lookingTimer: ReturnType<typeof setTimeout> | null = null;

export function isLooking(): boolean {
  return lookingTimer !== null;
}

/** Start looking, or keep looking for another few minutes (after each exchange). */
export function keepLooking(ms = LOOKING_IDLE_MS): void {
  const was = isLooking();
  if (lookingTimer) clearTimeout(lookingTimer);
  lookingTimer = setTimeout(() => stopLooking(), ms);
  if (!was) announce(true);
}

export function stopLooking(): void {
  if (!lookingTimer) return;
  clearTimeout(lookingTimer);
  lookingTimer = null;
  announce(false);
}

function announce(on: boolean): void {
  void sendCommand({ kind: "looking", on });
  sendToPanel({ type: "looking", on });
}
