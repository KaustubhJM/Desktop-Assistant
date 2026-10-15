// tray.ts — the system tray icon: the reliable way to find, show, hide or
// recover the robot, plus a small animation menu for trying its moves.

import { app, Menu, MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import { CLIPS, ROBOT_STATES, type ClipName, type RobotStateName } from "../shared/types";
import { currentVoiceState, getListenShortcut, wakeListening } from "./assistant";
import { sendCommand } from "./commands";
import { openPanel } from "./panelWindow";
import { endPeek, isPeeking, launchAtLoginEnabled, recover, RECOVER_SHORTCUT, setLaunchAtLogin, setSize, startPeek } from "./presence";
import { bringBack, getRobotWindow, setAlwaysOnTop } from "./robotWindow";
import { getSettings, updateSettings } from "./settings";
import { syncWake } from "./wake";
import { focusLabel, focusSession, startFocus, stopFocus } from "./focus";

let tray: Tray | null = null;

export function createTray(iconDataUrl: string): void {
  if (tray) return;
  const image = nativeImage.createFromDataURL(iconDataUrl);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(getSettings().name);
  tray.on("click", () => void recover());
  rebuildTrayMenu();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export function showRobot(greet: boolean): void {
  const win = getRobotWindow();
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  if (greet) void sendCommand({ kind: "state", state: "happy" });
  rebuildTrayMenu();
}

export function rebuildTrayMenu(): void {
  if (!tray) return;
  const settings = getSettings();
  const win = getRobotWindow();
  const visible = !!win?.isVisible();
  const name = settings.name;
  // Visible microphone indicator in the tray too.
  const focusing = focusLabel();
  tray.setToolTip(
    currentVoiceState() === "listening" ? `${name} — listening (microphone on)`
    : wakeListening() ? `${name} — listening for “Hey ${name}” (microphone on, nothing recorded)${focusing ? ` · ${focusing}` : ""}`
    : focusing ? `${name} — ${focusing}`
    : name,
  );

  const stateItems: MenuItemConstructorOptions[] = ROBOT_STATES.map((state: RobotStateName) => ({
    label: state,
    click: () => void sendCommand({ kind: "state", state }),
  }));
  const clipItems: MenuItemConstructorOptions[] = CLIPS.map((clip: ClipName) => ({
    label: clip,
    click: () => void sendCommand({ kind: "clip", clip }),
  }));

  const menu = Menu.buildFromTemplate([
    { label: name, enabled: false },
    { type: "separator" },
    visible
      ? { label: `Hide ${name}`, click: () => { win?.hide(); rebuildTrayMenu(); } }
      : { label: `Show ${name}`, click: () => showRobot(true) },
    { label: "Open chat", click: () => openPanel() },
    focusSession()
      ? { label: `Stop the timer (${focusLabel()})`, click: () => stopFocus() }
      : { label: "Focus for 25 minutes", click: () => void startFocus(25) },
    { label: "Listen", accelerator: getListenShortcut() ?? undefined, click: () => void sendCommand({ kind: "listen-toggle" }) },
    { label: `Bring ${name} back`, accelerator: RECOVER_SHORTCUT, click: () => void recover() },
    { label: `Move ${name} to the corner`, click: () => void (isPeeking() ? endPeek() : Promise.resolve()).then(() => { bringBack(); showRobot(true); }) },
    isPeeking()
      ? { label: "Come out", click: () => void endPeek() }
      : { label: "Peek from the edge now", enabled: visible, click: () => void startPeek() },
    {
      label: `Hands-free: listen for “Hey ${name}”`,
      type: "checkbox",
      checked: settings.wakeWord,
      click: (item) => {
        updateSettings({ wakeWord: item.checked });
        void syncWake();
      },
    },
    { type: "separator" },
    {
      label: "Hide at the screen edge when I'm away",
      type: "checkbox",
      checked: settings.peekEnabled,
      click: (item) => { updateSettings({ peekEnabled: item.checked }); rebuildTrayMenu(); },
    },
    {
      label: "Away after (no keyboard or mouse input)",
      enabled: settings.peekEnabled,
      submenu: [1, 2, 3, 5, 10, 15, 30].map((min): MenuItemConstructorOptions => ({
        label: `${min} minute${min > 1 ? "s" : ""}`,
        type: "radio",
        checked: settings.peekAfterSeconds === min * 60,
        click: () => updateSettings({ peekAfterSeconds: min * 60 }),
      })),
    },
    {
      label: "Greet me once each time I sign in",
      type: "checkbox",
      checked: settings.greetOnLogin,
      click: (item) => updateSettings({ greetOnLogin: item.checked }),
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: launchAtLoginEnabled(),
      click: (item) => { setLaunchAtLogin(item.checked); rebuildTrayMenu(); },
    },
    {
      label: "Always on top",
      type: "checkbox",
      checked: settings.alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: "Speak replies",
      type: "checkbox",
      checked: settings.speak,
      click: (item) => {
        updateSettings({ speak: item.checked });
        void sendCommand({ kind: "speak-enabled", enabled: item.checked });
      },
    },
    {
      label: "Size",
      submenu: (["small", "medium", "large"] as const).map((size): MenuItemConstructorOptions => ({
        label: size[0].toUpperCase() + size.slice(1),
        type: "radio",
        checked: settings.size === size,
        click: () => void setSize(size),
      })),
    },
    {
      label: "Theme",
      submenu: [
        { label: "Ivory and cyan", type: "radio", checked: settings.theme === "ivory-cyan", click: () => setTheme("ivory-cyan") },
        { label: "Silver and purple", type: "radio", checked: settings.theme === "silver-purple", click: () => setTheme("silver-purple") },
      ],
    },
    { type: "separator" },
    { label: "Try a state", submenu: stateItems },
    { label: "Try a move", submenu: clipItems },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function setTheme(theme: "ivory-cyan" | "silver-purple"): void {
  updateSettings({ theme });
  void sendCommand({ kind: "theme", theme });
  rebuildTrayMenu();
}
