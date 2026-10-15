// assistant.ts — conversation and voice plumbing in the main process.
//
//   typed:  panel ──chat──▶ main ──/chat──▶ backend
//   voice:  robot (mic) ──WAV──▶ main ──/stt──▶ backend, then as typed
//   reply:  main ──▶ robot (speaks it, reacts) and ──▶ panel (shows it)
//   voice:  robot ──tts──▶ main ──/tts──▶ backend (local Kokoro) ──WAV──▶ robot
//
// The microphone is only ever opened by the robot window, only while you
// asked it to listen (mic button / push-to-talk), and its "listening" face
// and the panel's mic button show when it's on.

import { globalShortcut, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { Backend } from "./backend";
import type { CalendarStatus, ChatMessage, ChatResult, ClipName, Fact, Thread, NewTask, Occurrence, PanelData, PanelSettings, RobotSize, Task, ThemeName, VoiceState } from "../shared/types";
import { sendCommand } from "./commands";
import { openLink, openWebLink } from "./links";
import { log } from "./log";
import { closePanel, getPanelWindow, isPanelOpen, openPanel, sendToPanel, togglePanel } from "./panelWindow";
import { setSize } from "./presence";
import { getRobotWindow } from "./robotWindow";
import { getSettings, updateSettings } from "./settings";
import { setWakeMuted, startWake, syncWake, wakeListening, wakeNote } from "./wake";
import { syncActivity } from "./activity";
import { musicOnVoice, musicSpeechDue, musicTurn } from "./musicHold";
import { current as currentMood, moodEvent, moodForPrompt, setBattery } from "./mood";
import { focusForPrompt, focusLabel, startFocus, stopFocus } from "./focus";
import { grabScreen, isLooking, keepLooking, stopLooking } from "./screen";

/**
 * Push-to-talk: the first of these that no other app has claimed. A global
 * shortcut steals the keys from every app, so editor favourites (VS Code's
 * Ctrl+Shift+Space) are only a last resort.
 */
const LISTEN_CANDIDATES = ["Control+Alt+Space", "Control+Alt+M", "Alt+Shift+M", "Control+Alt+J", "Control+Shift+Space"];
let listenShortcut: string | null = null;

export function getListenShortcut(): string | null {
  return listenShortcut;
}

/** "Control+Alt+M" -> "Ctrl + Alt + M" */
export function prettyShortcut(accelerator: string | null): string {
  return accelerator ? accelerator.replace("Control", "Ctrl").split("+").join(" + ") : "not available";
}
const VOICES = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova", "bf_emma"];

let voiceState: VoiceState = "idle";
/** When the last spoken reply was sent to the robot (to log how long the voice took to start). */
let replySentAt = 0;
let onTrayChange: () => void = () => undefined;

export function startAssistant(getBackend: () => Backend | null, trayChanged: () => void): void {
  onTrayChange = trayChanged;
  // "Hey Bit": what it hears after the name runs like a spoken message.
  startWake(getBackend, (text) => {
    sendToPanel({ type: "user", text, source: "voice" });
    void runTurn(getBackend, text, "voice");
  }, () => {
    onTrayChange();
    sendToPanel({ type: "settings", settings: panelSettings() });
  });
  const fromRobot = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === getRobotWindow()?.webContents;
  const fromPanel = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === getPanelWindow()?.webContents;

  // Microphone: only the robot window, only audio.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = "mediaTypes" in details ? (details.mediaTypes ?? []).every((t) => t === "audio") : true;
    callback(permission === "media" && audioOnly && wc === getRobotWindow()?.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === "media" && wc === getRobotWindow()?.webContents);

  for (const candidate of LISTEN_CANDIDATES) {
    if (globalShortcut.register(candidate, () => void sendCommand({ kind: "listen-toggle" }))) {
      listenShortcut = candidate;
      break;
    }
    log(`push-to-talk: ${candidate} is taken by another app, trying the next one`);
  }
  log(`push-to-talk shortcut: ${listenShortcut ?? "none available"}`);

  // ---- robot → main
  ipcMain.on("toggle-panel", (e) => {
    if (fromRobot(e)) togglePanel();
  });
  ipcMain.on("voice-state", (e, state: VoiceState) => {
    if (!fromRobot(e)) return;
    voiceState = state;
    // Don't let it hear itself talking, or listen twice during push-to-talk.
    setWakeMuted(state === "speaking" || state === "listening");
    musicOnVoice(state); // the mic opening pauses the music; it comes back when it's all over
    if (state === "speaking" && replySentAt) {
      log(`voice: started speaking ${Date.now() - replySentAt} ms after the reply was ready`);
      replySentAt = 0;
    }
    sendToPanel({ type: "voice-state", state });
    onTrayChange();
  });
  // Petting and clicking it cheer it up; the battery affects its energy (mood.ts).
  ipcMain.on("robot-moment", (e, moment: unknown) => {
    if (fromRobot(e) && (moment === "pet" || moment === "click")) moodEvent(moment);
  });
  ipcMain.on("battery", (e, level: unknown, charging: unknown) => {
    if (fromRobot(e) && typeof level === "number" && typeof charging === "boolean") setBattery(level, charging);
  });
  ipcMain.handle("tts", async (e, text: unknown) => {
    const backend = getBackend();
    if (!fromRobot(e) || typeof text !== "string" || !backend?.ready) return null;
    try {
      return await backend.speak(text.slice(0, 1000), getSettings().voice);
    } catch (err) {
      log("tts failed:", String(err));
      return null;
    }
  });
  ipcMain.handle("voice-input", async (e, wav: unknown, followUp: unknown) => {
    // (push-to-talk, or answering in a conversation)
    if (!fromRobot(e) || !(wav instanceof ArrayBuffer || ArrayBuffer.isView(wav))) return { ok: false };
    const buffer = wav instanceof ArrayBuffer ? wav : (wav as Uint8Array).slice().buffer;
    const backend = getBackend();
    let text: string | null = null;
    const heardAt = Date.now();
    try {
      text = (await backend?.transcribe(buffer, getSettings().sttQuality)) ?? null;
      log(`voice: transcribed in ${Date.now() - heardAt} ms (${getSettings().sttQuality})`);
    } catch (err) {
      log("stt failed:", String(err));
    }
    if (followUp === true && text !== null && isNoise(text)) {
      // Heard something in a conversation window, but not words for us
      // (a fan, the TV, Whisper's "Thank you."): end the conversation quietly.
      log("conversation: ended (only noise)");
      return { ok: true, text: "" }; // the robot goes back to idle by itself
    }
    if (!text) {
      await deliverReply({ ok: true, say: text === null ? "Sorry, my ears aren't working right now." : "Sorry, I didn't catch that.", mood: "curious" });
      return { ok: true, text: "" };
    }
    text = withoutWakeWord(text);
    sendToPanel({ type: "user", text, source: "voice" });
    void runTurn(getBackend, text, "voice");
    return { ok: true, text };
  });

  // ---- panel → main
  ipcMain.handle("panel-data", async (e): Promise<PanelData | null> => {
    if (!fromPanel(e)) return null;
    const backend = getBackend();
    const [history, tasks] = await Promise.all([
      backend?.getJson<ChatMessage[]>("/conversation?limit=100") ?? null,
      backend?.getJson<Task[]>("/schedule") ?? null,
    ]);
    return {
      settings: panelSettings(),
      history: history ?? [],
      tasks: tasks ?? [],
      backendReady: !!backend?.ready,
      voices: VOICES,
      listenShortcut: prettyShortcut(listenShortcut),
      voiceState,
      mood: currentMood().name,
      focus: focusLabel(),
      looking: isLooking(),
    };
  });
  ipcMain.handle("panel-send", async (e, text: unknown) => {
    if (!fromPanel(e) || typeof text !== "string" || !text.trim() || text.length > 2000) return { ok: false };
    void runTurn(getBackend, text.trim(), "typed");
    return { ok: true };
  });
  ipcMain.on("panel-listen", (e) => {
    if (fromPanel(e)) void sendCommand({ kind: "listen-toggle" });
  });
  ipcMain.on("panel-stop", (e) => {
    if (fromPanel(e)) void sendCommand({ kind: "stop-speaking" });
  });
  ipcMain.on("panel-close", (e) => {
    if (fromPanel(e)) closePanel();
  });
  ipcMain.on("panel-test-voice", (e) => {
    if (fromPanel(e)) void sendCommand({ kind: "test-voice" });
  });
  ipcMain.handle("panel-settings", async (e, patch: Partial<PanelSettings>) => {
    if (!fromPanel(e) || typeof patch !== "object" || !patch) return panelSettings();
    await applySettings(patch);
    return panelSettings();
  });
  ipcMain.handle("panel-open-link", async (e, url: unknown) => {
    // A source link you clicked in the chat (search answers). Only plain https web pages.
    return fromPanel(e) ? openWebLink(url) : false;
  });
  ipcMain.handle("panel-delete-history", async (e) => {
    if (!fromPanel(e)) return 0;
    const res = await getBackend()?.getJson<{ deleted: number }>("/conversation", "DELETE");
    sendToPanel({ type: "history-cleared" });
    return res?.deleted ?? 0;
  });
  // ---- conversations (threads) and what it remembers about you (backend/memory.py)
  ipcMain.handle("panel-threads", async (e) => {
    if (!fromPanel(e)) return [];
    return (await getBackend()?.getJson<Thread[]>("/threads")) ?? [];
  });
  ipcMain.handle("panel-thread-new", async (e) => {
    if (!fromPanel(e)) return null;
    stopLooking(); // a new conversation isn't about the screen
    return (await getBackend()?.send<Thread>("/threads", "POST", {}))?.data ?? null;
  });
  ipcMain.handle("panel-thread-select", async (e, id: unknown) => {
    if (!fromPanel(e) || typeof id !== "string" || !/^[\w-]{1,40}$/.test(id)) return [];
    stopLooking();
    return (await getBackend()?.send<Thread[]>(`/threads/${id}/select`, "POST"))?.data ?? [];
  });
  ipcMain.handle("panel-thread-delete", async (e, id: unknown) => {
    if (!fromPanel(e) || typeof id !== "string" || !/^[\w-]{1,40}$/.test(id)) return [];
    return (await getBackend()?.send<Thread[]>(`/threads/${id}`, "DELETE"))?.data ?? [];
  });
  ipcMain.handle("panel-facts", async (e) => {
    if (!fromPanel(e)) return [];
    return (await getBackend()?.getJson<Fact[]>("/memories")) ?? [];
  });
  ipcMain.handle("panel-fact-forget", async (e, key: unknown) => {
    if (!fromPanel(e) || typeof key !== "string" || !/^[a-z0-9_]{1,60}$/.test(key)) return [];
    return (await getBackend()?.send<Fact[]>(`/memories/${key}`, "DELETE"))?.data ?? [];
  });
  ipcMain.handle("panel-tasks", async (e) => {
    if (!fromPanel(e)) return [];
    return (await getBackend()?.getJson<Task[]>("/schedule")) ?? [];
  });

  // ---- tasks (Today tab)
  ipcMain.handle("panel-items", async (e, days: unknown) => {
    if (!fromPanel(e)) return [];
    const n = Math.min(Math.max(Number(days) || 7, 0), 60);
    const backend = getBackend();
    const [items, events] = await Promise.all([
      backend?.getJson<Occurrence[]>(`/items?days=${n}`) ?? null,
      backend?.getJson<{ id: string; title: string; date: string; time: string | null; location: string }[]>(`/calendar/events?days=${n}`) ?? null,
    ]);
    // Google Calendar events alongside your tasks (read-only), in time order.
    const cal: Occurrence[] = (events ?? []).map((ev) => ({
      item_id: -1, title: ev.title, notes: null, date: ev.date, time: ev.time, repeat: null, repeat_text: "",
      done: false, occurrence: `${ev.id}`, calendar: true, location: ev.location,
    }));
    return [...(items ?? []), ...cal].sort((a, b) => (a.date + (a.time ?? "99:99")).localeCompare(b.date + (b.time ?? "99:99")));
  });
  ipcMain.handle("panel-calendar", async (e, action: unknown) => {
    if (!fromPanel(e)) return null;
    const backend = getBackend();
    if (action === "connect") return (await backend?.send<CalendarStatus>("/calendar/connect", "POST"))?.data ?? null;
    if (action === "disconnect") return (await backend?.send<CalendarStatus>("/calendar/disconnect", "POST"))?.data ?? null;
    return (await backend?.getJson<CalendarStatus>("/calendar/status")) ?? null;
  });
  ipcMain.handle("panel-add-item", async (e, task: NewTask) => {
    if (!fromPanel(e) || !task || typeof task.title !== "string") return { ok: false, error: "invalid task" };
    const res = await getBackend()?.send<{ id?: number; detail?: string }>("/items", "POST", {
      title: task.title.slice(0, 200),
      due_date: task.date || "today",
      due_time: task.time || null,
      rrule: task.repeat || null,
    });
    if (!res?.ok) return { ok: false, error: friendlyError(res?.data?.detail) };
    void sendCommand({ kind: "clip", clip: "nod" });
    return { ok: true };
  });
  ipcMain.handle("panel-set-done", async (e, itemId: unknown, date: unknown, done: unknown) => {
    if (!fromPanel(e) || !Number.isInteger(itemId) || typeof date !== "string") return { ok: false };
    const res = await getBackend()?.send(`/items/${itemId}/complete?done=${done ? "true" : "false"}&date=${encodeURIComponent(date)}`, "POST");
    if (res?.ok && done) {
      void sendCommand({ kind: "state", state: "happy" });
      void sendCommand({ kind: "effect", effect: "confetti" });
      moodEvent("task");
    }
    return { ok: !!res?.ok };
  });
  ipcMain.handle("panel-delete-item", async (e, itemId: unknown) => {
    if (!fromPanel(e) || !Number.isInteger(itemId)) return { ok: false };
    const res = await getBackend()?.send(`/items/${itemId}`, "DELETE");
    return { ok: !!res?.ok };
  });

  // ---- reminder bubble buttons (robot)
  ipcMain.handle("reminder-action", async (e, action: unknown, itemId: unknown, occurrence: unknown) => {
    if (!fromRobot(e) || !Number.isInteger(itemId) || typeof occurrence !== "string") return { ok: false };
    const backend = getBackend();
    if (action === "done") {
      const res = await backend?.send(`/items/${itemId}/complete?done=true&date=${encodeURIComponent(occurrence.slice(0, 10))}`, "POST");
      if (res?.ok) {
        void sendCommand({ kind: "effect", effect: "confetti" });
        moodEvent("task");
      }
      sendToPanel({ type: "tasks-changed" });
      return { ok: !!res?.ok };
    }
    if (action === "snooze") {
      const res = await backend?.send<{ until: string }>(`/items/${itemId}/snooze?occurrence=${encodeURIComponent(occurrence)}&minutes=10`, "POST");
      return { ok: !!res?.ok, until: res?.data?.until };
    }
    return { ok: false };
  });
}

export function currentVoiceState(): VoiceState {
  return voiceState;
}

export { wakeListening };

export { openPanel, isPanelOpen };

const IGNORED_TEXT = "🤫 That didn't sound like it was meant for me, so I stayed quiet.";

/** One conversation turn, typed or spoken. (Exported for the self-test.) */
export async function runTurn(getBackend: () => Backend | null, text: string, source: "typed" | "voice"): Promise<void> {
  musicTurn(1); // the music stays paused while it works out the answer
  try {
    await turn(getBackend, text, source);
  } finally {
    musicTurn(-1);
  }
}

async function turn(getBackend: () => Backend | null, text: string, source: "typed" | "voice"): Promise<void> {
  const backend = getBackend();
  const startedAt = Date.now();
  moodEvent("chat"); // talking to it cheers it up
  void sendCommand({ kind: "state", state: "thinking" });
  sendToPanel({ type: "voice-state", state: "thinking" });
  // Looking at your screen: this message comes with a fresh screenshot.
  const shot = isLooking() ? await grabScreen() : null;
  let result: ChatResult = backend
    ? await backend.chat(text, source, getSettings().name, moodForPrompt(), focusForPrompt(), shot ?? undefined)
    : { ok: false, error: "backend not running" };
  if (source === "voice") log(`voice: reply worked out in ${Date.now() - startedAt} ms`);
  if (!result.ok) {
    log("chat failed:", result.error ?? "");
    await deliverReply({ ok: true, say: "Hmm, I can't reach my brain right now.", mood: "sleepy", offline: true });
    return;
  }
  if (result.ignored) {
    // A video or other people, not you: no voice, just the "hm?" look and a soft
    // chime; the chat says why (so a miss is easy to spot and repeat).
    sendToPanel({ type: "assistant", text: IGNORED_TEXT, details: null, offline: false, remembered: [] });
    sendToPanel({ type: "voice-state", state: "idle" });
    await sendCommand({ kind: "ignored" });
    return;
  }
  if (result.screen_mode === false) stopLooking(); // "stop looking"
  else if (result.screen_mode === true) keepLooking(); // still talking about the screen
  let clip: ClipName | undefined = result.move ?? undefined; // "do a backflip"
  if (result.focus?.stop) stopFocus();
  else if (result.focus?.minutes) startFocus(result.focus.minutes);
  if (result.open_url) {
    // "Play lofi on YouTube": open it in the browser (links.ts only allows YouTube).
    if (await openLink(result.open_url)) {
      if (result.open_url.includes("/watch")) clip = "dance"; // the music's starting
    } else {
      result = { ...result, say: "I couldn't open YouTube, sorry.", mood: "curious" };
    }
  }
  if (result.search) {
    // "Let me look that up" now, the answer when the search is done.
    await deliverReply(result, undefined, false, true);
    let answer = await backend!.search(result.search.query, result.search.question, result.thread_id);
    if (!answer.ok) {
      log("search failed:", answer.error ?? "");
      answer = { ok: true, say: "I couldn't search the web right now — try again in a minute.", mood: "curious" };
    }
    result = answer;
  }
  if (result.look) {
    // "Help me with this": the screenshot first (the screen as it was when
    // you asked), then "let me take a look" while a model that can see reads it.
    const shot = await grabScreen();
    if (!shot) {
      result = { ok: true, say: "I couldn't take a screenshot of your screen, sorry.", mood: "curious" };
    } else {
      await deliverReply(result, undefined, false, true);
      let answer = await backend!.look(shot.image, shot.mime, result.look.question, getSettings().name, result.thread_id);
      if (!answer.ok) {
        log("look failed:", answer.error ?? "");
        answer = { ok: true, say: "I couldn't look at your screen right now. Try again in a minute.", mood: "curious" };
      }
      if (answer.screen_mode) keepLooking(); // follow-up questions see the screen too
      result = answer;
    }
  }
  // Spoken conversation keeps going while there's something to answer;
  // typed chat never opens the microphone by itself.
  const listenAfter = source === "voice" && !!result.follow_up;
  await deliverReply(result, clip, listenAfter);
  if (result.applied || result.calendar_changed) sendToPanel({ type: "tasks-changed" });
  if (result.applied && (result.action?.type === "complete" || result.action?.type === "done")) {
    void sendCommand({ kind: "effect", effect: "confetti" }); // "I finished the assignment"
    moodEvent("task");
  }
  sendToPanel({ type: "threads-changed" }); // a new chat gets its name; what it remembers may have changed
}

async function deliverReply(result: ChatResult, clip?: ClipName, listenAfter = false, thenThink = false): Promise<void> {
  const say = result.say ?? result.reply ?? "";
  sendToPanel({ type: "assistant", text: say, details: result.details ?? null, offline: result.offline, remembered: result.remembered ?? [] });
  if (thenThink) sendToPanel({ type: "voice-state", state: "thinking" });
  if (say.trim() && !result.quiet && getSettings().speak) {
    musicSpeechDue(); // the voice starts once it's synthesised: the music waits for it
    replySentAt = Date.now();
  }
  await sendCommand({ kind: "reply", say, mood: result.mood ?? "neutral", bubble: !isPanelOpen(), clip, quiet: !!result.quiet, listenAfter, thenThink });
}

/**
 * What Whisper typically "hears" in noise or music: nothing, a stray word, or
 * a stock phrase learned from subtitles.
 */
function isNoise(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 2) return true;
  return /^(thank you|thanks for watching|thank you for watching|thanks|you|uh|um|hmm|bye bye|music|applause|silence)( very much)?$/.test(t);
}

/** "Hey Bit, what's up" said during a conversation: the name isn't part of the message. */
function withoutWakeWord(text: string): string {
  const names = ["bit", getSettings().name.toLowerCase()].map((n) => n.replace(/[^a-z]/g, "")).filter(Boolean);
  const stripped = text.replace(new RegExp(`^\\s*(hey|hi|okay|ok)[\\s,!.-]+(${names.join("|")})\\b[\\s,.!?-]*`, "i"), "");
  return stripped.trim() ? stripped : text;
}

/** Turn a backend validation message into something friendly. */
function friendlyError(detail: unknown): string {
  const d = String(detail ?? "");
  if (/time/i.test(d)) return "That time doesn't look right — use something like 18:30.";
  if (/date/i.test(d)) return "That date doesn't look right.";
  if (/repeat/i.test(d)) return "I can't repeat it that way.";
  if (/title/i.test(d)) return "Give the task a name first.";
  return "I couldn't save that — is the backend running?";
}

function panelSettings(): PanelSettings {
  const s = getSettings();
  return { name: s.name, speak: s.speak, voice: s.voice, sttQuality: s.sttQuality, size: s.size, theme: s.theme, followMouse: s.followMouse, wakeWord: s.wakeWord, followActivity: s.followActivity, sounds: s.sounds, checkIns: s.checkIns, wander: s.wander, wakeNote: wakeNote() };
}

async function applySettings(patch: Partial<PanelSettings>): Promise<void> {
  if (typeof patch.name === "string" && patch.name.trim()) {
    updateSettings({ name: patch.name.trim().slice(0, 24) });
    await syncWake(); // "Hey <new name>"
  }
  if (typeof patch.checkIns === "boolean") updateSettings({ checkIns: patch.checkIns });
  if (typeof patch.wander === "boolean") updateSettings({ wander: patch.wander });
  if (typeof patch.sounds === "boolean") {
    updateSettings({ sounds: patch.sounds });
    void sendCommand({ kind: "sounds", on: patch.sounds });
  }
  if (typeof patch.followActivity === "boolean") {
    updateSettings({ followActivity: patch.followActivity });
    await syncActivity();
    if (!patch.followActivity) void sendCommand({ kind: "activity", activity: "none", music: false, look: [0, 0] });
  }
  if (typeof patch.wakeWord === "boolean") {
    updateSettings({ wakeWord: patch.wakeWord });
    await syncWake();
  }
  if (typeof patch.speak === "boolean") {
    updateSettings({ speak: patch.speak });
    void sendCommand({ kind: "speak-enabled", enabled: patch.speak });
  }
  if (typeof patch.voice === "string" && VOICES.includes(patch.voice)) {
    updateSettings({ voice: patch.voice });
    void sendCommand({ kind: "voice", voice: patch.voice });
  }
  if (patch.sttQuality === "fast" || patch.sttQuality === "accurate" || patch.sttQuality === "online") {
    updateSettings({ sttQuality: patch.sttQuality });
    await syncWake(); // "Hey Bit" commands use the same choice
  }
  if (typeof patch.followMouse === "boolean") {
    updateSettings({ followMouse: patch.followMouse });
    void sendCommand({ kind: "follow-mouse", enabled: patch.followMouse });
  }
  if (patch.theme === "ivory-cyan" || patch.theme === "silver-purple") {
    updateSettings({ theme: patch.theme as ThemeName });
    void sendCommand({ kind: "theme", theme: patch.theme });
  }
  if (patch.size === "small" || patch.size === "medium" || patch.size === "large") await setSize(patch.size as RobotSize);
  onTrayChange();
}
