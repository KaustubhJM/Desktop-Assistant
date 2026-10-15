// panel/main.ts — the compact chat panel: conversation, today's tasks, settings.
// All rendering of message text goes through textContent / DOM nodes (never
// innerHTML), so nothing the AI writes can inject markup.

import "./panel.css";
import type { CalendarStatus, ChatMessage, Fact, Occurrence, PanelData, PanelEvent, PanelSettings, Thread, VoiceState } from "../../../shared/types";

const api = window.panel;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const messagesEl = $<HTMLDivElement>("messages");
const typingEl = $<HTMLDivElement>("typing");
const stopBtn = $<HTMLButtonElement>("stop");
const input = $<HTMLInputElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const micBtn = $<HTMLButtonElement>("mic");
const statusEl = $<HTMLDivElement>("status");
const tasksEl = $<HTMLDivElement>("tasks");

let data: PanelData | null = null;
let settings: PanelSettings;
let messageCount = 0;
let mood: string | undefined;
let focus: string | null | undefined;
let looking = false;
let currentVoice: VoiceState = "idle";
const MOOD_WORDS: Record<string, string> = { playful: "feeling playful", happy: "happy", content: "content", bored: "a bit bored", lonely: "missing you", tired: "sleepy" };
let backendReady = true;
let shortcut = "Ctrl + Alt + Space";

// --------------------------------------------------------------------- start

async function init(): Promise<void> {
  data = await api.getData();
  if (!data) return;
  settings = data.settings;
  backendReady = data.backendReady;
  shortcut = data.listenShortcut;
  mood = data.mood;
  focus = data.focus;
  looking = !!data.looking;
  applySettings();
  renderHistory(data.history);
  void loadTasks();
  void loadThreads();
  void loadFacts();
  void api.calendar("status").then(showCalendar);
  shortcut = data.listenShortcut;
  $<HTMLElement>("shortcut").textContent = shortcut;
  setVoiceState(data.voiceState);
  scrollToEnd();
  input.focus();
}

function applySettings(): void {
  $<HTMLDivElement>("name").textContent = settings.name;
  input.placeholder = `Message ${settings.name}…`;
  $<HTMLInputElement>("set-name").value = settings.name;
  $<HTMLInputElement>("set-speak").checked = settings.speak;
  $<HTMLInputElement>("set-follow").checked = settings.followMouse;
  $<HTMLInputElement>("set-wake").checked = settings.wakeWord;
  $<HTMLInputElement>("set-activity").checked = settings.followActivity;
  $<HTMLInputElement>("set-sounds").checked = settings.sounds;
  $<HTMLInputElement>("set-checkins").checked = settings.checkIns;
  $<HTMLInputElement>("set-wander").checked = settings.wander;
  $<HTMLElement>("wake-label").textContent = `Hands-free: say “Hey ${settings.name}”`;
  $<HTMLElement>("wake-note").textContent = settings.wakeNote ?? "";
  $<HTMLElement>("stt-note").textContent = {
    fast: "On this laptop. Quick; often mishears names",
    accurate: "On this laptop. Better with names; slower",
    online: "Sends only what you say to me (not the “Hey Bit” listening) to Groq. Best with names",
  }[settings.sttQuality];
  const voiceSel = $<HTMLSelectElement>("set-voice");
  if (!voiceSel.options.length && data) {
    for (const v of data.voices) voiceSel.append(new Option(voiceLabel(v), v));
  }
  voiceSel.value = settings.voice;
  for (const seg of document.querySelectorAll<HTMLElement>(".segmented")) {
    const key = seg.dataset.setting as keyof PanelSettings;
    for (const b of seg.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.value === settings[key]);
  }
}

function voiceLabel(v: string): string {
  const names: Record<string, string> = {
    af_heart: "Heart (warm)",
    af_bella: "Bella (bright)",
    af_nicole: "Nicole (soft)",
    af_sarah: "Sarah",
    af_sky: "Sky",
    af_nova: "Nova",
    bf_emma: "Emma (British)",
  };
  return names[v] ?? v;
}

// ----------------------------------------------------------------- messages

function showEmpty(): void {
  const p = document.createElement("div");
  p.className = "empty";
  p.textContent = `Say hi to ${settings?.name ?? "me"}! Type below, or press the mic (${shortcut}) and talk.`;
  messagesEl.append(p);
}

function renderHistory(history: ChatMessage[]): void {
  messagesEl.replaceChildren();
  messageCount = 0;
  for (const m of history) addMessage(m, false);
  if (!history.length) showEmpty();
  scrollToEnd();
}

/** Show another conversation (after switching, starting a new one, or deleting one). */
async function reloadConversation(): Promise<void> {
  const fresh = await api.getData();
  if (fresh) renderHistory(fresh.history);
  await loadThreads();
}

// ---------------------------------------------------------------- conversations

const threadSelect = $<HTMLSelectElement>("thread-select");
let threads: Thread[] = [];

async function loadThreads(): Promise<void> {
  threads = await api.threads();
  threadSelect.replaceChildren(...threads.map((t) => new Option(t.title, t.id, false, t.current)));
  $<HTMLButtonElement>("thread-delete").disabled = threads.length < 2 && messageCount === 0;
}

threadSelect.addEventListener("change", async () => {
  await api.selectThread(threadSelect.value);
  await reloadConversation();
  input.focus();
});
$<HTMLButtonElement>("thread-new").addEventListener("click", async () => {
  await api.newThread();
  await reloadConversation();
  input.focus();
});
$<HTMLButtonElement>("thread-delete").addEventListener("click", async () => {
  const current = threads.find((t) => t.current);
  if (!current || !window.confirm(`Delete the conversation “${current.title}”? What ${settings.name} remembers about you stays.`)) return;
  await api.deleteThread(current.id);
  await reloadConversation();
});

// ------------------------------------------------------- what it remembers about you

// ---------------------------------------------------------------- Google Calendar

async function showCalendar(status: CalendarStatus | null): Promise<void> {
  const note = $<HTMLElement>("cal-note");
  const btn = $<HTMLButtonElement>("cal-btn");
  if (!status) {
    note.textContent = "Can't check right now";
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.disabled = status.connecting;
  btn.textContent = status.connected ? "Disconnect" : status.connecting ? "Waiting…" : "Connect";
  note.textContent = status.connected
    ? "Connected: your events show in Today, remind you, and I can add new ones"
    : status.connecting ? "Approve in the browser window that opened"
    : status.error ?? (status.set_up ? "Not connected" : "Needs a one-time setup (see the README), then Connect");
  if (status.connecting) {
    await new Promise((r) => setTimeout(r, 2000));
    await showCalendar(await api.calendar("status"));
    void loadTasks();
  }
}

$<HTMLButtonElement>("cal-btn").addEventListener("click", async () => {
  const status = await api.calendar("status");
  await showCalendar(await api.calendar(status?.connected ? "disconnect" : "connect"));
  void loadTasks();
});

async function loadFacts(): Promise<void> {
  const facts: Fact[] = await api.facts();
  const list = $<HTMLUListElement>("facts");
  list.replaceChildren(
    ...facts.map((f) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = f.fact;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "fact-forget";
      del.title = "Forget this";
      del.setAttribute("aria-label", `Forget: ${f.fact}`);
      del.textContent = "×";
      del.addEventListener("click", async () => {
        await api.forgetFact(f.key);
        await loadFacts();
      });
      li.append(text, del);
      return li;
    }),
  );
  $<HTMLElement>("memory-count").textContent = facts.length ? `${facts.length} thing${facts.length === 1 ? "" : "s"} · shared by all conversations` : "Nothing yet — tell me about yourself!";
}

function addMessage(m: ChatMessage & { offline?: boolean; remembered?: string[] }, scroll = true): void {
  messagesEl.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${m.role}`;
  if (m.role === "user" && m.source === "voice") el.classList.add("voice");
  if (m.offline) el.classList.add("offline");
  el.append(renderInline(m.text));
  if (m.details) {
    const d = document.createElement("div");
    d.className = "details";
    d.append(renderMarkdown(m.details));
    el.append(d);
  }
  for (const fact of m.remembered ?? []) {
    const note = document.createElement("div");
    note.className = "remembered";
    note.textContent = `Remembered: ${fact}`;
    el.append(note);
  }
  messagesEl.append(el);
  messageCount++;
  updateMemoryCount();
  if (scroll) scrollToEnd();
}

function scrollToEnd(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateMemoryCount(): void {
  // (the Settings line now counts what it remembers about you: loadFacts)
}

/** Inline markdown subset: `code`, **bold** and [links](https://…). Built from DOM nodes, not HTML. */
function renderInline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) frag.append(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("[")) {
      // A source link: opens in your browser (main checks it's a plain https page).
      const [, label, url] = token.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      const a = document.createElement("a");
      a.textContent = label;
      a.href = "#";
      a.title = new URL(url).hostname.replace(/^www\./, "");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void api.openLink(url);
      });
      frag.append(a);
    } else {
      const el = document.createElement(token.startsWith("`") ? "code" : "strong");
      el.textContent = token.startsWith("`") ? token.slice(1, -1) : token.slice(2, -2);
      frag.append(el);
    }
    last = m.index! + token.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** Block markdown subset: ``` code fences, - / 1. lists, paragraphs. */
function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      const pre = document.createElement("pre");
      const c = document.createElement("code");
      c.textContent = code.join("\n");
      pre.append(c);
      frag.append(pre);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)/;
    const numbered = /^\s*\d+[.)]\s+(.*)/;
    if (bullet.test(line) || numbered.test(line)) {
      const isNum = numbered.test(line);
      const list = document.createElement(isNum ? "ol" : "ul");
      while (i < lines.length && (isNum ? numbered : bullet).test(lines[i])) {
        const li = document.createElement("li");
        li.append(renderInline(lines[i].replace(isNum ? numbered : bullet, "$1")));
        list.append(li);
        i++;
      }
      frag.append(list);
      continue;
    }
    if (line.trim()) {
      const p = document.createElement("p");
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("```") && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
        para.push(lines[i++].replace(/^#+\s*/, ""));
      }
      p.append(renderInline(para.join(" ")));
      frag.append(p);
      continue;
    }
    i++;
  }
  return frag;
}

// ------------------------------------------------------------- voice state

function setVoiceState(state: VoiceState): void {
  currentVoice = state;
  document.body.classList.toggle("listening", state === "listening");
  micBtn.classList.toggle("on", state === "listening");
  micBtn.title = state === "listening" ? "Stop listening" : `Talk (${shortcut})`;
  typingEl.classList.toggle("hidden", state !== "thinking");
  stopBtn.classList.toggle("hidden", state !== "speaking");
  statusEl.className = `status ${state === "idle" ? (backendReady ? "" : "offline") : state}`;
  statusEl.textContent =
    state === "listening" ? "Listening — microphone on" : state === "thinking" ? "Thinking…" : state === "speaking" ? "Speaking"
    : !backendReady ? "Brain offline" : looking ? "👀 Looking at your screen · say “stop looking”" : focus ? focus : mood && MOOD_WORDS[mood] ? `Online · ${MOOD_WORDS[mood]}` : "Online";
  if (state === "thinking") scrollToEnd();
}

api.onEvent((e: PanelEvent) => {
  switch (e.type) {
    case "user":
      if (e.source === "voice") addMessage({ role: "user", text: e.text, source: "voice" });
      break;
    case "assistant":
      addMessage({ role: "assistant", text: e.text, details: e.details, offline: e.offline, remembered: e.remembered });
      typingEl.classList.add("hidden");
      break;
    case "voice-state":
      setVoiceState(e.state);
      break;
    case "tasks-changed":
      void loadTasks();
      break;
    case "settings":
      settings = e.settings;
      applySettings();
      break;
    case "mood":
      mood = e.mood;
      setVoiceState(currentVoice);
      break;
    case "focus":
      focus = e.label;
      setVoiceState(currentVoice);
      break;
    case "looking":
      looking = e.on;
      setVoiceState(currentVoice);
      break;
    case "threads-changed":
      void loadThreads();
      void loadFacts();
      break;
    case "history-cleared":
      messagesEl.replaceChildren();
      messageCount = 0;
      updateMemoryCount();
      showEmpty();
      break;
  }
});

// ------------------------------------------------------------------ compose

$<HTMLFormElement>("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendBtn.disabled = true;
  addMessage({ role: "user", text, source: "typed" });
  typingEl.classList.remove("hidden");
  scrollToEnd();
  void api.send(text).finally(() => {
    sendBtn.disabled = false;
    input.focus();
  });
});

micBtn.addEventListener("click", () => api.listen());
stopBtn.addEventListener("click", () => api.stopSpeaking());
$<HTMLButtonElement>("close").addEventListener("click", () => api.close());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.close();
});

// --------------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === tab));
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === "today") void loadTasks();
    if (tab.dataset.tab === "chat") input.focus();
  });
}

// -------------------------------------------------------------------- today

const WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(iso: string): string {
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (iso === localISO(today)) return "Today";
  if (iso === localISO(tomorrow)) return "Tomorrow";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

async function loadTasks(): Promise<void> {
  renderTasks(await api.items(7));
}

function renderTasks(items: Occurrence[]): void {
  tasksEl.replaceChildren();
  if (!items.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.style.cssText = "margin:auto;text-align:center;color:var(--muted);padding:20px";
    p.textContent = "Nothing in the next 7 days. Add something above, or just tell me.";
    tasksEl.append(p);
    return;
  }
  const now = new Date();
  const todayIso = localISO(now);
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const next = items.find((t) => !t.calendar && t.date === todayIso && !t.done && (!t.time || t.time >= hm));
  let lastDay = "";
  for (const t of items) {
    if (t.date !== lastDay) {
      lastDay = t.date;
      const h = document.createElement("div");
      h.className = "day-heading";
      h.textContent = dayLabel(t.date);
      tasksEl.append(h);
    }
    const row = document.createElement("div");
    row.className = "task";
    if (t.calendar) {
      // A Google Calendar event: shown, not editable here.
      row.classList.add("calendar");
      const icon = document.createElement("span");
      icon.className = "check cal-icon";
      icon.textContent = "📅";
      icon.title = "From your Google Calendar";
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = t.time ?? "all day";
      const what = document.createElement("span");
      what.className = "what";
      what.textContent = t.title;
      if (t.location) {
        const r = document.createElement("small");
        r.className = "repeat";
        r.textContent = t.location;
        what.append(r);
      }
      row.append(icon, time, what);
      tasksEl.append(row);
      continue;
    }
    if (t.done) row.classList.add("done");
    if (t.date === todayIso && t.time && t.time < hm) row.classList.add("past");
    if (t === next) row.classList.add("next");

    const check = document.createElement("button");
    check.className = "check";
    check.type = "button";
    check.title = t.done ? "Mark as not done" : "Mark as done";
    check.setAttribute("aria-label", check.title);
    check.addEventListener("click", async () => {
      await api.setDone(t.item_id, t.date, !t.done);
      void loadTasks();
    });

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = t.time ?? "—";

    const what = document.createElement("span");
    what.className = "what";
    what.textContent = t.title;
    if (t.repeat) {
      const r = document.createElement("small");
      r.className = "repeat";
      r.textContent = t.repeat_text;
      what.append(r);
    }

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.title = "Delete";
    del.setAttribute("aria-label", `Delete ${t.title}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      const all = t.repeat ? ` and all its repeats (${t.repeat_text})` : "";
      if (!window.confirm(`Delete "${t.title}"${all}?`)) return;
      await api.deleteItem(t.item_id);
      void loadTasks();
    });

    row.append(check, time, what);
    if (t === next) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Next";
      row.append(tag);
    }
    row.append(del);
    tasksEl.append(row);
  }
}

const taskTitle = $<HTMLInputElement>("task-title");
const taskDate = $<HTMLInputElement>("task-date");
const taskTime = $<HTMLInputElement>("task-time");
const taskRepeat = $<HTMLSelectElement>("task-repeat");
const taskError = $<HTMLDivElement>("task-error");
taskDate.value = localISO(new Date());

$<HTMLFormElement>("add-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = taskTitle.value.trim();
  if (!title) {
    taskTitle.focus();
    return;
  }
  let repeat = taskRepeat.value || null;
  if (repeat === "weekly") {
    const [y, m, d] = (taskDate.value || localISO(new Date())).split("-").map(Number);
    repeat = `FREQ=WEEKLY;BYDAY=${WEEKDAY[new Date(y, m - 1, d).getDay()]}`;
  }
  const res = await api.addItem({ title, date: taskDate.value || localISO(new Date()), time: taskTime.value || null, repeat });
  taskError.classList.toggle("hidden", res.ok);
  if (!res.ok) {
    taskError.textContent = res.error ?? "Couldn't add that.";
    return;
  }
  taskTitle.value = "";
  taskTime.value = "";
  taskRepeat.value = "";
  void loadTasks();
});

// ----------------------------------------------------------------- settings

async function update(patch: Partial<PanelSettings>): Promise<void> {
  settings = await api.updateSettings(patch);
  applySettings();
}

$<HTMLInputElement>("set-name").addEventListener("change", (e) => void update({ name: (e.target as HTMLInputElement).value }));
$<HTMLInputElement>("set-speak").addEventListener("change", (e) => void update({ speak: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>("set-follow").addEventListener("change", (e) => void update({ followMouse: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>("set-wander").addEventListener("change", (e) => void update({ wander: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>("set-checkins").addEventListener("change", (e) => void update({ checkIns: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>("set-sounds").addEventListener("change", (e) => void update({ sounds: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>("set-activity").addEventListener("change", (e) => void update({ followActivity: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>("set-wake").addEventListener("change", (e) => void update({ wakeWord: (e.target as HTMLInputElement).checked }));
$<HTMLSelectElement>("set-voice").addEventListener("change", (e) => void update({ voice: (e.target as HTMLSelectElement).value }));
$<HTMLButtonElement>("test-voice").addEventListener("click", () => api.testVoice());
for (const seg of document.querySelectorAll<HTMLElement>(".segmented")) {
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b?.dataset.value) void update({ [seg.dataset.setting!]: b.dataset.value } as Partial<PanelSettings>);
  });
}
$<HTMLButtonElement>("forget").addEventListener("click", async () => {
  if (!window.confirm(`Forget everything? ${settings.name} will delete every conversation and everything it remembers about you.`)) return;
  await api.deleteHistory();
  await reloadConversation();
  await loadFacts();
});

void init();
