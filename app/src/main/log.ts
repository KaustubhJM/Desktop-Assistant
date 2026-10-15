// log.ts — tiny file logger (userData/logs/*.log), so problems after an
// autostart can be diagnosed without a terminal attached.

import { app } from "electron";
import fs from "fs";
import path from "path";

const MAX_BYTES = 1_000_000;

export function logFile(name: string): string {
  return path.join(app.getPath("userData"), "logs", `${name}.log`);
}

export function appendLog(name: string, text: string): void {
  const file = logFile(name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, `${file}.old`);
    }
    fs.appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  } catch {
    // Logging must never take the app down.
  }
}

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  appendLog("main", line);
}
