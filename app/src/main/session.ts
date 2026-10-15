// session.ts — "have I already greeted you in this Windows session?"
//
// A Windows session is identified by the logon ID of the current sign-in
// (`whoami /logonid`, e.g. S-1-5-5-0-1443450) together with the boot time.
// Boot time alone isn't enough: with Fast Startup, "shut down + power on"
// keeps the same boot time but is a new sign-in; signing out and back in
// also starts a new session. The logon ID changes in both cases. Boot time
// is added because logon IDs only stay unique until the next reboot.

import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface SessionKey {
  logonId: string;
  bootMs: number;
}

interface Stored extends SessionKey {
  greetedAt: string;
}

/** Boot time from uptime wobbles by a second or two between reads. */
const BOOT_TOLERANCE_MS = 2 * 60_000;

export async function currentSession(): Promise<SessionKey> {
  const bootMs = Date.now() - os.uptime() * 1000;
  let logonId = "unknown";
  if (process.platform === "win32") {
    try {
      // Full path: a PATH with Git Bash first would find its unrelated `whoami`.
      const whoami = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
      const { stdout } = await execFileAsync(whoami, ["/logonid"], { timeout: 5000, windowsHide: true });
      const match = stdout.match(/S-1-5-5-[\d-]+/);
      if (match) logonId = match[0];
    } catch {
      // whoami missing or blocked: fall back to boot time alone
    }
  }
  return { logonId, bootMs };
}

export function sameSession(a: SessionKey, b: SessionKey): boolean {
  return a.logonId === b.logonId && Math.abs(a.bootMs - b.bootMs) < BOOT_TOLERANCE_MS;
}

/**
 * True if this session hasn't been greeted yet — and records that it now
 * has. Relaunching in the same session returns false; the first launch of
 * a new session (at login or by hand) returns true.
 */
export function claimGreeting(file: string, session: SessionKey): boolean {
  try {
    const last = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
    if (sameSession(last, session)) return false;
  } catch {
    // never greeted, or unreadable record: greet
  }
  const record: Stored = { ...session, greetedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return true;
}

const GREETINGS: Record<"morning" | "afternoon" | "evening" | "night", string[]> = {
  morning: ["Good morning! I'm here if you need me.", "Morning! Ready for today?", "Good morning! Let's have a good day."],
  afternoon: ["Good afternoon! Nice to see you.", "Hi again! What are we doing this afternoon?", "Hello! I'm all charged up."],
  evening: ["Good evening! I'm here if you need me.", "Hey, good evening! How was your day?", "Evening! Let's get things done."],
  night: ["Working late? I'll keep you company.", "Hi! It's late, don't forget to rest.", "Hello, night owl!"],
};

export function greetingText(now = new Date()): string {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
  const options = GREETINGS[part];
  return options[Math.floor(Math.random() * options.length)];
}
