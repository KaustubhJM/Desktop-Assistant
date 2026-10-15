// preload — the only bridge between the pages and the main process.
// Exposes small, fixed APIs; the pages never get Node or raw IPC. Main also
// checks which window each message comes from, so the panel can't use the
// robot's channels or vice versa.

import { contextBridge, ipcRenderer } from "electron";
import type { BackendEvent, CommandEnvelope, NewTask, Occurrence, PanelData, PanelEvent, PanelSettings, RobotConfig, Task, VoiceState, Thread, Fact, CalendarStatus } from "../shared/types";

const robot = {
  getConfig: (): Promise<RobotConfig> => ipcRenderer.invoke("get-config"),
  setClickThrough: (enabled: boolean): void => ipcRenderer.send("set-click-through", enabled),
  dragStart: (): void => ipcRenderer.send("drag-start"),
  dragEnd: (): void => ipcRenderer.send("drag-end"),
  peekExit: (): void => ipcRenderer.send("peek-exit"),
  togglePanel: (): void => ipcRenderer.send("toggle-panel"),
  moment: (moment: "pet" | "click"): void => ipcRenderer.send("robot-moment", moment),
  battery: (level: number, charging: boolean): void => ipcRenderer.send("battery", level, charging),
  tts: (text: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke("tts", text),
  /** followUp: recorded in a conversation window (not on request), so noise ends it silently. */
  voiceInput: (wav: ArrayBuffer, followUp = false): Promise<{ ok: boolean; text?: string }> => ipcRenderer.invoke("voice-input", wav, followUp === true),
  voiceState: (state: VoiceState): void => ipcRenderer.send("voice-state", state),
  reminderAction: (action: "done" | "snooze", itemId: number, occurrence: string): Promise<{ ok: boolean; until?: string }> =>
    ipcRenderer.invoke("reminder-action", action, itemId, occurrence),
  setTrayIcon: (dataUrl: string): void => ipcRenderer.send("tray-icon", dataUrl),
  ready: (): void => ipcRenderer.send("renderer-ready"),
  commandDone: (id: number, result?: unknown): void => ipcRenderer.send("command-done", id, result),
  onBackendEvent: (cb: (event: BackendEvent) => void): void => {
    ipcRenderer.on("backend-event", (_e, event: BackendEvent) => cb(event));
  },
  onCommand: (cb: (envelope: CommandEnvelope) => void): void => {
    ipcRenderer.on("robot-command", (_e, envelope: CommandEnvelope) => cb(envelope));
  },
};

const panel = {
  getData: (): Promise<PanelData | null> => ipcRenderer.invoke("panel-data"),
  send: (text: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("panel-send", text),
  listen: (): void => ipcRenderer.send("panel-listen"),
  stopSpeaking: (): void => ipcRenderer.send("panel-stop"),
  testVoice: (): void => ipcRenderer.send("panel-test-voice"),
  close: (): void => ipcRenderer.send("panel-close"),
  updateSettings: (patch: Partial<PanelSettings>): Promise<PanelSettings> => ipcRenderer.invoke("panel-settings", patch),
  deleteHistory: (): Promise<number> => ipcRenderer.invoke("panel-delete-history"),
  openLink: (url: string): Promise<boolean> => ipcRenderer.invoke("panel-open-link", url),
  threads: (): Promise<Thread[]> => ipcRenderer.invoke("panel-threads"),
  newThread: (): Promise<Thread | null> => ipcRenderer.invoke("panel-thread-new"),
  selectThread: (id: string): Promise<Thread[]> => ipcRenderer.invoke("panel-thread-select", id),
  deleteThread: (id: string): Promise<Thread[]> => ipcRenderer.invoke("panel-thread-delete", id),
  facts: (): Promise<Fact[]> => ipcRenderer.invoke("panel-facts"),
  forgetFact: (key: string): Promise<Fact[]> => ipcRenderer.invoke("panel-fact-forget", key),
  calendar: (action: "status" | "connect" | "disconnect"): Promise<CalendarStatus | null> => ipcRenderer.invoke("panel-calendar", action),
  tasks: (): Promise<Task[]> => ipcRenderer.invoke("panel-tasks"),
  items: (days = 7): Promise<Occurrence[]> => ipcRenderer.invoke("panel-items", days),
  addItem: (task: NewTask): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("panel-add-item", task),
  setDone: (itemId: number, date: string, done: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("panel-set-done", itemId, date, done),
  deleteItem: (itemId: number): Promise<{ ok: boolean }> => ipcRenderer.invoke("panel-delete-item", itemId),
  onEvent: (cb: (event: PanelEvent) => void): void => {
    ipcRenderer.on("panel-event", (_e, event: PanelEvent) => cb(event));
  },
};

export type RobotApi = typeof robot;
export type PanelApi = typeof panel;

contextBridge.exposeInMainWorld("robot", robot);
contextBridge.exposeInMainWorld("panel", panel);
