// commands.ts — send a command to the robot renderer and (optionally) wait
// until it has been applied and drawn.

import { ipcMain } from "electron";
import type { CommandEnvelope, RobotCommand } from "../shared/types";
import { getRobotWindow } from "./robotWindow";

let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();

ipcMain.on("command-done", (event, id: number, result: unknown) => {
  if (event.sender !== getRobotWindow()?.webContents) return;
  pending.get(id)?.(result);
  pending.delete(id);
});

export function sendCommand<T = unknown>(command: RobotCommand, timeoutMs = 8000): Promise<T | undefined> {
  const win = getRobotWindow();
  if (!win) return Promise.resolve(undefined);
  const id = nextId++;
  const envelope: CommandEnvelope = { id, command };
  return new Promise((resolve) => {
    pending.set(id, resolve as (r: unknown) => void);
    setTimeout(() => {
      if (pending.delete(id)) resolve(undefined);
    }, timeoutMs);
    win.webContents.send("robot-command", envelope);
  });
}
