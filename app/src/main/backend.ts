// backend.ts — starts, watches and stops the Python backend (FastAPI).
//
// - Picks a free localhost port and a fresh secret token on every launch, so
//   no other program (or web page) can talk to the backend.
// - Keeps the backend's stdin open; the backend exits when it closes, so it
//   never outlives the app even if the app crashes.
// - Restarts it (with backoff) if it dies unexpectedly.
// - Relays the backend's WebSocket pushes (reminders, replies) to listeners.
// The token never leaves the main process: the renderer goes through IPC.

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import type { BackendEvent, ChatResult } from "../shared/types";
import { appendLog, log } from "./log";

export interface BackendOptions {
  backendDir: string;
  pythonPath: string;
  /** Extra environment for the backend process (the self-test uses a temp DB and no API keys). */
  env?: Record<string, string>;
}

type Listener = (event: BackendEvent) => void;

const HEALTH_TIMEOUT_MS = 20_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 120_000;

export class Backend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private port = 0;
  private readonly token = randomBytes(24).toString("hex");
  private stopping = false;
  private restarts: number[] = [];
  private listeners: Listener[] = [];
  private _ready = false;
  private readyListeners: (() => void)[] = [];

  constructor(private readonly options: BackendOptions) {}

  get ready(): boolean {
    return this._ready;
  }

  /** Called every time the backend (re)starts and is ready for requests. */
  onReady(fn: () => void): void {
    this.readyListeners.push(fn);
  }

  onEvent(listener: Listener): void {
    this.listeners.push(listener);
  }

  async start(): Promise<void> {
    const { backendDir, pythonPath } = this.options;
    if (!fs.existsSync(pythonPath)) {
      throw new Error(`Python not found at ${pythonPath}`);
    }
    if (!fs.existsSync(path.join(backendDir, "main.py"))) {
      throw new Error(`Backend not found in ${backendDir}`);
    }

    this.stopping = false;
    this.port = await freePort();
    const child = spawn(
      pythonPath,
      ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(this.port), "--log-level", "warning"],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          ...this.options.env,
          REMINDER_TOKEN: this.token,
          REMINDER_WATCH_STDIN: "1",
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        },
        windowsHide: true,
      },
    );
    this.child = child;
    child.stdout.on("data", (d) => appendLog("backend", d.toString()));
    child.stderr.on("data", (d) => appendLog("backend", d.toString()));
    child.on("exit", (code, signal) => this.handleExit(child, code, signal));

    await this.waitUntilHealthy();
    this._ready = true;
    this.connectSocket();
    log(`backend ready on port ${this.port} (pid ${child.pid})`);
    for (const fn of this.readyListeners) fn();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this._ready = false;
    this.socket?.close();
    this.socket = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.stdin.end(); // the backend's watchdog exits on EOF
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** One conversation turn. Never throws: problems come back as ok:false. */
  async chat(text: string, source: "typed" | "voice", name: string, mood = "", focus = "", screenshot?: { image: string; mime: string }): Promise<ChatResult> {
    if (!this._ready) return { ok: false, error: "backend not running" };
    try {
      const body = JSON.stringify({ text, source, name, mood, focus, ...(screenshot ? { image: screenshot.image, mime: screenshot.mime } : {}) });
      const res = await this.request("/chat", { method: "POST", body, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return { ok: false, error: `backend replied ${res.status}` };
      const data = (await res.json()) as Omit<ChatResult, "ok">;
      return { ok: true, ...data, reply: data.say };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Step two of a turn that needs the web: the search answer, shaped like a chat reply. */
  async search(query: string, question: string, threadId?: string): Promise<ChatResult> {
    if (!this._ready) return { ok: false, error: "backend not running" };
    try {
      const res = await this.request("/search", { method: "POST", body: JSON.stringify({ query, question, thread_id: threadId ?? null }), signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return { ok: false, error: `backend replied ${res.status}` };
      const data = (await res.json()) as Omit<ChatResult, "ok">;
      return { ok: true, ...data, reply: data.say };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Step two of "help me with this": the answer from a screenshot, shaped like a chat reply. */
  async look(image: string, mime: string, question: string, name: string, threadId?: string): Promise<ChatResult> {
    if (!this._ready) return { ok: false, error: "backend not running" };
    try {
      const body = JSON.stringify({ image, mime, question, name, thread_id: threadId ?? null });
      const res = await this.request("/look", { method: "POST", body, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) return { ok: false, error: `backend replied ${res.status}` };
      const data = (await res.json()) as Omit<ChatResult, "ok">;
      return { ok: true, ...data, reply: data.say };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Local speech recognition: 16-bit PCM WAV in, text out. */
  async transcribe(wav: ArrayBuffer, quality: string): Promise<string | null> {
    if (!this._ready) return null;
    const res = await this.request(`/stt?quality=${encodeURIComponent(quality)}`, {
      method: "POST",
      body: Buffer.from(wav),
      headers: { "Content-Type": "audio/wav" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`stt failed: ${res.status}`);
    return ((await res.json()) as { text: string }).text;
  }

  /** Local voice: text in, WAV bytes out. */
  async speak(text: string, voice: string): Promise<ArrayBuffer> {
    const res = await this.request("/tts", { method: "POST", body: JSON.stringify({ text, voice }), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`tts failed: ${res.status}`);
    return res.arrayBuffer();
  }

  /** JSON request; never throws. */
  async send<T>(route: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
    if (!this._ready) return { ok: false, status: 0, data: null };
    try {
      const res = await this.request(route, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as T | null;
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  async getJson<T>(route: string, method = "GET"): Promise<T | null> {
    if (!this._ready) return null;
    try {
      const res = await this.request(route, { method });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  /** Authenticated request to the backend (main process only). */
  request(route: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${route}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) {
        throw new Error("backend exited during startup (see logs/backend.log)");
      }
      try {
        const res = await this.request("/next", { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    throw new Error("backend did not become healthy in time");
  }

  private connectSocket(): void {
    if (this.stopping || !this._ready) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${this.token}`);
    this.socket = ws;
    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as BackendEvent;
        for (const l of this.listeners) l(event);
      } catch (err) {
        log("bad backend message", String(err));
      }
    };
    ws.onclose = () => {
      if (this.socket === ws && !this.stopping) setTimeout(() => this.connectSocket(), 2000);
    };
    ws.onerror = () => ws.close();
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
    if (child !== this.child && this.child !== null) return; // an old process
    this._ready = false;
    if (this.stopping) return;
    log(`backend exited unexpectedly (code ${code}, signal ${signal})`);
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      log("backend keeps crashing; giving up until the app restarts");
      for (const l of this.listeners) l({ type: "status", text: "backend-down" });
      return;
    }
    this.restarts.push(now);
    const delay = 1000 * 2 ** (this.restarts.length - 1);
    setTimeout(() => {
      this.start().catch((err) => log("backend restart failed:", String(err)));
    }, delay);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
