// index.ts — desktop lifecycle: one instance, the robot window, the tray,
// the Python backend, and clean shutdown.

import { app, ipcMain, Notification, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type { BackendEvent, RobotConfig } from "../shared/types";
import { Backend } from "./backend";
import { sendCommand } from "./commands";
import { log } from "./log";
import { startAssistant } from "./assistant";
import { startMusicHold } from "./musicHold";
import { closePanel } from "./panelWindow";
import { endPeek, isPeeking, onPauseChange, onResume, recover, startPresence } from "./presence";
import { createRobotWindow, dragEnd, dragStart, getRobotWindow, setClickThrough } from "./robotWindow";
import { claimGreeting, currentSession, greetingText } from "./session";
import { flushSettings, getSettings, loadSettings } from "./settings";
import { createTray, destroyTray, rebuildTrayMenu } from "./tray";
import { handleWakeEvent, syncWake } from "./wake";
import { noteActivity, startActivity, syncActivity } from "./activity";
import { startStayingOnTop } from "./onTop";
import { startMood } from "./mood";
import { checkNow, morningHelloPending, startCheckins } from "./checkins";
import { isFocusing, startFocusTimer } from "./focus";
import { startWander } from "./wander";
import { currentActivity } from "./activity";
import { currentVoiceState } from "./assistant";
import { sendToPanel } from "./panelWindow";

const selftestDir = process.env.BIT_SELFTEST_DIR;
if (process.env.BIT_USER_DATA) app.setPath("userData", process.env.BIT_USER_DATA);

let backend: Backend | null = null;
let rendererReady!: () => void;
const rendererReadyPromise = new Promise<void>((r) => (rendererReady = r));

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running; it will bring the robot back.
  app.quit();
} else {
  app.on("second-instance", () => {
    // A relaunch never greets again; it just brings the robot back.
    log("second launch: bringing the existing robot back");
    void recover();
  });
  app.whenReady().then(start);
}

async function start(): Promise<void> {
  app.setAppUserModelId("com.desk-robot.bit");
  loadSettings();
  registerIpc();
  const win = createRobotWindow();
  // Keep "Show/Hide" and "Peek now" in the tray menu in sync with the window.
  win.on("show", rebuildTrayMenu);
  win.on("hide", rebuildTrayMenu);
  startPresence(rebuildTrayMenu);
  startAssistant(() => backend, rebuildTrayMenu);
  startMusicHold(() => backend);
  startActivity(() => backend);
  startStayingOnTop(); // full-screen browsers otherwise bury the robot after a click
  void rendererReadyPromise.then(() => startMood((m) => sendToPanel({ type: "mood", mood: m.name })));
  // Speaking up now and then; not while it's talking or listening.
  startCheckins(() => backend, () => currentVoiceState() !== "idle" || isFocusing());
  startFocusTimer(rebuildTrayMenu);
  // Moving around now and then — never while you code, focus, or it's busy/hidden/asleep.
  let locked = false;
  onPauseChange((on) => (locked = on));
  startWander(
    () => backend,
    () => !locked && !isPeeking() && !isFocusing() && currentVoiceState() === "idle" && currentActivity() !== "coding",
  );
  // Back from sleep / unlocked: check for due (or missed) reminders right away.
  onResume(() => void backend?.send("/scheduler/check", "POST"));
  log(`started${selftestDir ? " (self-test)" : ""}`);

  void startBackend();

  if (!selftestDir) {
    await rendererReadyPromise;
    await maybeGreet();
  } else {
    const { runSelftest } = await import("./selftest");
    const ready = await Promise.race([rendererReadyPromise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 30_000))]);
    if (!ready) {
      log("selftest: the robot page never became ready (see renderer errors above)");
      app.quit();
      return;
    }
    await runSelftest(selftestDir, () => backend);
  }
}

async function startBackend(): Promise<void> {
  const backendDir = process.env.BIT_BACKEND_DIR ?? path.resolve(app.getAppPath(), "..", "backend");
  const pythonPath = getSettings().pythonPath ?? path.join(backendDir, "venv", "Scripts", "python.exe");
  const env: Record<string, string> = {};
  if (process.env.BIT_BACKEND_DB) env.REMINDER_DB_PATH = process.env.BIT_BACKEND_DB;
  if (process.env.BIT_NO_LLM === "1") Object.assign(env, { GEMINI_API_KEY: "", GROQ_API_KEY: "" });

  backend = new Backend({ backendDir, pythonPath, env });
  backend.onEvent((event) => void forwardToRobot(event));
  backend.onReady(() => {
    // Settings that live in the backend, again after any restart.
    void syncWake(); // "Hey Bit"
    void syncActivity(); // matching what you're doing
    void refreshBadge();
    // The morning hello can come right away (once a day).
    if (!selftestDir) setTimeout(() => void checkNow(), 15_000);
  });
  try {
    await backend.start();
  } catch (err) {
    log("backend failed to start:", String(err));
    await rendererReadyPromise;
    void forwardToRobot({ type: "status", text: "backend-down" });
  }
}

/** Greet once per Windows session (first launch after sign-in, or first manual launch). */
async function maybeGreet(): Promise<void> {
  if (!getSettings().greetOnLogin) return;
  if (morningHelloPending()) return; // the morning hello (checkins.ts) is the greeting today
  const session = await currentSession();
  const file = path.join(app.getPath("userData"), "session.json");
  if (claimGreeting(file, session)) {
    log(`greeting new session ${session.logonId}`);
    await sendCommand({ kind: "greet", text: greetingText() });
  } else {
    log("same session as last greeting: not greeting again");
  }
}

/** A little badge on special days (festivals, your birthday); checked hourly. */
// The robot page starts with sounds on; apply the setting once it's ready.
void rendererReadyPromise.then(() => sendCommand({ kind: "sounds", on: getSettings().sounds }));

async function refreshBadge(): Promise<void> {
  const today = await backend?.getJson<{ emoji: string; label: string } | null>("/occasion");
  await rendererReadyPromise;
  void sendCommand({ kind: "badge", emoji: today?.emoji ?? null, label: today?.label ?? "" });
}
setInterval(() => void refreshBadge(), 60 * 60 * 1000);

async function forwardToRobot(event: BackendEvent): Promise<void> {
  if (event.type === "wake") void handleWakeEvent(event);
  if (event.type === "activity") event = noteActivity(event);
  // A due reminder brings the robot out of hiding first.
  if (event.type === "reminder" && isPeeking()) await endPeek();
  const win = getRobotWindow();
  // Robot hidden from the tray: still show the reminder as a Windows notification.
  if (event.type === "reminder" && win && !win.isVisible() && Notification.isSupported()) {
    new Notification({ title: getSettings().name, body: event.text, silent: false }).show();
  }
  win?.webContents.send("backend-event", event);
}

/** Only accept IPC from our own robot window. */
function fromRobot(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === getRobotWindow()?.webContents;
}

function registerIpc(): void {
  ipcMain.on("set-click-through", (e, enabled: boolean) => {
    if (fromRobot(e)) setClickThrough(Boolean(enabled));
  });
  ipcMain.on("drag-start", (e) => {
    if (!fromRobot(e)) return;
    closePanel(); // the panel is anchored to where the robot was
    dragStart();
  });
  ipcMain.on("drag-end", (e) => {
    if (fromRobot(e)) dragEnd();
  });
  ipcMain.on("tray-icon", (e, dataUrl: string) => {
    if (fromRobot(e) && typeof dataUrl === "string" && dataUrl.startsWith("data:image/png")) createTray(dataUrl);
  });
  ipcMain.on("renderer-ready", (e) => {
    if (fromRobot(e)) rendererReady();
  });
  ipcMain.on("peek-exit", (e) => {
    if (fromRobot(e)) void endPeek();
  });
  ipcMain.handle("get-config", (e): RobotConfig | null => {
    if (!fromRobot(e)) return null;
    const s = getSettings();
    return { name: s.name, theme: s.theme, speak: s.speak, selftest: !!selftestDir, size: s.size, voice: s.voice, followMouse: s.followMouse };
  });
}

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void (async () => {
    destroyTray();
    flushSettings();
    await backend?.stop();
    app.quit();
  })();
});

app.on("window-all-closed", () => app.quit());
