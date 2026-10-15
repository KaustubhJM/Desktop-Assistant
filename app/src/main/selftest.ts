// selftest.ts — dev-only verification run (BIT_SELFTEST_DIR=<folder>).
// Drives the real app and writes evidence to that folder:
//   - captures of every expression, state and mid-animation frame (+ contact sheets)
//   - transparency check of the window background
//   - click-through hit tests, asked of Windows itself (no mouse movement)
//   - drag + clamping with a simulated cursor
//   - a real reminder from the backend, and the chat round trip
//   - CPU / memory while idle and while animating
// Then it quits. Nothing here runs in normal use.

import { app, desktopCapturer, globalShortcut, powerMonitor, screen, type Display, type NativeImage, type Point } from "electron";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { CLIPS, EXPRESSIONS, layoutFor, type ClipName, type RobotCommand } from "../shared/types";
import type { Backend } from "./backend";
import { sendCommand } from "./commands";
import { runTurn } from "./assistant";
import { chooseEdge, peekWindowPosition, type DisplayLike } from "./edges";
import { isAllowedLink, isSafeWebLink, setLinkOpener } from "./links";
import { handleWakeEvent, setWakeMuted, syncWake } from "./wake";
import { noteActivity, syncActivity } from "./activity";
import { current as currentMood, energyFor, moodEvent, moodName, setHourSource, tick as moodTick } from "./mood";
import { checkNow, compose as composeCheckin, decide as decideCheckin, setCheckinActivity, Stretch } from "./checkins";
import { focusSession, startFocus, stopFocus } from "./focus";
import { blockers as wanderBlockers, perchSpot, setForegroundSource, strollSpot, tick as wanderTick, type ForegroundWindow } from "./wander";
import { BrowserWindow } from "electron";
import { startStayingOnTop, stopStayingOnTop } from "./onTop";
import { log } from "./log";
import { setMusicHold } from "./musicHold";
import { captureScreen, isLooking, keepLooking, setScreenGrabber, stopLooking } from "./screen";
import { endPeek, isPeeking, launchAtLoginEnabled, RECOVER_SHORTCUT, setIdleSource, setLaunchAtLogin, setSize, startPeek } from "./presence";
import { clampToDisplays, dragEnd, dragStart, ensureVisible, getRobotWindow, moveWindow, setCursorSource } from "./robotWindow";
import { closePanel, getPanelWindow, openPanel } from "./panelWindow";
import { claimGreeting, sameSession } from "./session";
import { currentLayout as L, getSettings, updateSettings } from "./settings";
import type { Edge } from "../shared/types";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Results = Record<string, unknown>;

export async function runSelftest(dir: string, getBackend: () => Backend | null): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const results: Results = {};
  const save = () => fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
  try {
    // Nobody is "idle" during the test unless a step says so.
    setIdleSource(() => 0);
    // Don't react to what's really happening on this laptop (your music would
    // keep it from hiding, and override the activity section's fake moods),
    // and no check-ins talking over the other tests.
    updateSettings({ followActivity: false, checkIns: false, wander: false });
    setMusicHold(false); // listening must never pause (or resume) your real music
    // Work in the top-left, away from wherever your own copy of the robot
    // sits, so Windows' "which window is here?" checks only see the test robot.
    const wa0 = screen.getPrimaryDisplay().workArea;
    moveWindow(getRobotWindow()!, wa0.x + 40 - L().box.x + 20, wa0.y + 40);
    ensureVisible();
    await waitFor(() => !!getBackend()?.ready, 30_000);
    results.backendReady = !!getBackend()?.ready;
    await syncActivity();

    // BIT_SELFTEST_ONLY=peek,drag runs just those sections (faster iteration).
    const only = process.env.BIT_SELFTEST_ONLY?.split(",");
    const steps: [string, () => unknown][] = [
      ["unit", () => unitChecks(dir, results)],
      ["captures", () => captures(dir, results)],
      ["dynamic", () => dynamicTests(dir, results)],
      ["transparency", () => transparency(dir, results)],
      ["click", () => clickThrough(results)],
      ["drag", () => dragTest(results)],
      ["peek", () => peekTests(dir, results)],
      ["system", () => systemTests(results)],
      ["size", () => sizeTests(dir, results)],
      ["voice", () => voiceTests(dir, results, getBackend())],
      ["tasks", () => taskTests(dir, results, getBackend())],
      ["backend", () => backendFlow(dir, results, getBackend())],
      ["youtube", () => youtubeTests(results, getBackend())],
      ["apps", () => appsTests(results, getBackend())],
      ["search", () => searchTests(dir, results, getBackend())],
      ["look", () => lookTests(dir, results, getBackend())],
      ["ignore", () => ignoreTests(results, getBackend())],
      ["memory", () => memoryTests(dir, results, getBackend())],
      ["effects", () => effectsTests(dir, results)],
      ["mood", () => moodTests(results)],
      ["checkins", () => checkinTests(results, getBackend())],
      ["focus", () => focusTests(results)],
      ["wander", () => wanderTests(dir, results)],
      ["beat", () => beatTests(results)],
      ["wake", () => wakeTests(dir, results, getBackend())],
      ["conversation", () => conversationTests(results, getBackend())],
      ["activity", () => activityTests(dir, results, getBackend())],
      ["realclick", () => realClickTests(dir, results)],
      // Opens a full-screen browser (Edge, InPrivate), so only when asked for by name.
      ...(only?.includes("ontop") ? ([["ontop", () => onTopTests(dir, results)]] as [string, () => unknown][]) : []),
      ["metrics", () => metrics(results)],
    ];
    for (const [name, run] of steps) {
      if (only && !only.includes(name)) continue;
      await run();
      save();
    }
  } catch (err) {
    results.error = String((err as Error)?.stack ?? err);
    log("selftest error", results.error);
  }
  save();
  log("selftest finished");
  app.quit();
}

// ------------------------------------------------------------------ youtube

/** A full turn with a stubbed backend reply: the link is recorded, not opened. */
async function youtubeTests(results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.youtube = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true); // test replies must not play through your speakers
  const opened: string[] = [];
  setLinkOpener(async (url) => void opened.push(url));
  const realChat = backend.chat.bind(backend);
  const turn = async (reply: Partial<import("../shared/types").ChatResult>) => {
    backend.chat = async () => ({ ok: true, mood: "excited", ...reply });
    opened.length = 0;
    await runTurn(() => backend, "test", "typed");
    await watchRobot((r) => r.voiceState === "speaking", 8000);
    await watchRobot((r) => r.voiceState === "idle", 15_000); // the dance starts when it finishes talking
    await sleep(300);
    return sendCommand<{ bubble: string | null; clip: string | null }>({ kind: "debug-report" });
  };
  try {
    const video = "https://www.youtube.com/watch?v=jfKfPfyJRdk";
    const r1 = await turn({ say: "Playing \"lofi\" on YouTube.", open_url: video });
    const v1 = [...opened];
    const r2 = await turn({ say: "Here's YouTube for \"recursion\".", open_url: "https://www.youtube.com/results?search_query=recursion" });
    const v2 = [...opened];
    const r3 = await turn({ say: "Playing it.", open_url: "https://evil.example/watch?v=jfKfPfyJRdk" });
    const v3 = [...opened];
    results.youtube = {
      "video link opened, robot dances": v1[0] === video && r1?.clip === "dance" ? "pass" : `FAIL ${JSON.stringify({ v1, clip: r1?.clip })}`,
      "search link opened": v2.length === 1 && r2?.bubble?.includes("recursion") ? "pass" : `FAIL ${JSON.stringify({ v2, bubble: r2?.bubble })}`,
      "non-YouTube link refused and the robot says so": v3.length === 0 && /couldn't open YouTube/.test(r3?.bubble ?? "") ? "pass" : `FAIL ${JSON.stringify({ v3, bubble: r3?.bubble })}`,
    };
  } finally {
    backend.chat = realChat;
    setLinkOpener(async () => undefined);
  }
}

// --------------------------------------------------------------------- apps

/**
 * "Open calculator" through the real backend and your real Start menu, with no
 * model (a clear "open X" never needs one). The self-test's backend runs with
 * REMINDER_APPS_DRY_RUN=1 (scripts/run-selftest.mjs), so nothing really opens.
 */
async function appsTests(results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.apps = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true); // test replies must not play through your speakers
  await untilQuiet();
  const direct = await backend.chat("open calculator", "typed", getSettings().name);
  await runTurn(() => backend, "launch the calculator app", "typed");
  let report: { bubble: string | null } | undefined;
  for (let i = 0; i < 60 && !report?.bubble?.includes("Opening Calculator"); i++) {
    await sleep(250);
    report = await sendCommand<{ bubble: string | null }>({ kind: "debug-report" });
  }
  await watchRobot((r) => r.voiceState === "idle", 15_000);
  const website = await backend.chat("open youtube", "typed", getSettings().name);
  results.apps = {
    "'open calculator' finds it in the Start menu, no model needed": direct.ok && direct.say === "Opening Calculator." && direct.action?.type === "open_app" && direct.move === "nod" ? "pass" : `FAIL ${JSON.stringify(direct)}`,
    "the robot says what it opened": report?.bubble?.includes("Opening Calculator") ? "pass" : `FAIL ${JSON.stringify(report)}`,
    "a website isn't opened as an app": website.action?.type !== "open_app" ? "pass" : `FAIL ${JSON.stringify(website)}`,
  };
}

// ---------------------------------------------------------------- real clicks

/**
 * Real Windows mouse input (not simulated events): click the robot the way
 * you do, and check with screenshots of the actual screen that it's still
 * there afterwards. Moves your mouse pointer for a moment, then puts it back.
 */
async function realClickTests(dir: string, results: Results): Promise<void> {
  const win = getRobotWindow()!;
  setCursorSource(() => screen.getCursorScreenPoint());
  await sendCommand({ kind: "state", state: "idle" });
  closePanel();
  await sleep(800);
  const sf = screen.getPrimaryDisplay().scaleFactor;
  const box = L().box;
  const where = () => {
    const [x, y] = win.getPosition();
    return { x, y, cx: Math.round((x + box.x + box.width / 2) * sf), cy: Math.round((y + box.y + box.height * 0.55) * sf) };
  };
  const ps = async (script: string) => {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000 });
    return stdout.trim();
  };
  const header = `Add-Type -AssemblyName System.Drawing; Add-Type @"
using System; using System.Runtime.InteropServices;
public class RC { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, IntPtr e);
  public struct POINT { public int X, Y; } }
"@; [void][RC]::SetProcessDpiAwarenessContext([IntPtr](-4));`;
  const shot = async (name: string) => {
    const w = where();
    const file = path.join(dir, name);
    await ps(`${header} $b = New-Object System.Drawing.Bitmap 420, 460; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${w.cx - 210}, ${w.cy - 260}, 0, 0, $b.Size); $b.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`);
    return file;
  };
  /** Press and release at the robot; `wobble` = how far the hand slips between press and release (px). */
  const click = async (wobble: number) => {
    const w = where();
    await ps(`${header} $p = New-Object RC+POINT; [void][RC]::GetCursorPos([ref]$p);
      [void][RC]::SetCursorPos(${w.cx}, ${w.cy}); Start-Sleep -Milliseconds 450;
      [RC]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 90;
      for ($i = 1; $i -le 4; $i++) { [void][RC]::SetCursorPos(${w.cx} + [int](${wobble} * $i / 4), ${w.cy}); Start-Sleep -Milliseconds 15 }
      [RC]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 150;
      [void][RC]::SetCursorPos($p.X, $p.Y)`);
  };
  const state = async () => {
    const r = await sendCommand<{ state: string; shift: { x: number; y: number }; peek: string | null }>({ kind: "debug-report" });
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    return { visible: win.isVisible(), x, y, w, h, panel: !!getPanelWindow(), shift: r?.shift, peek: r?.peek, opacity: win.getOpacity() };
  };

  const out: Results = {};
  for (const [label, wobble] of [["clean click", 0], ["click with an 8 px slip", 8], ["second click (closes the panel)", 0]] as const) {
    const before = await state();
    await shot(`realclick-${label.split(" ")[0]}-${wobble}-before.png`);
    await click(wobble);
    await sleep(400);
    const soon = await state();
    await sleep(1500);
    const later = await state();
    const file = await shot(`realclick-${label.split(" ")[0]}-${wobble}-after.png`);
    out[label] = { before, soon, later, screenshot: path.basename(file) };
  }
  closePanel();
  results.realclick = out;
}

// ------------------------------------------------------- above full-screen apps

/**
 * Your report: click the robot while a full-screen browser is up, click back
 * on the video, and the robot is gone (buried, still working). Reproduced
 * with a real full-screen Chromium browser (Edge InPrivate: no sign-in, no
 * sync), real clicks and real screenshots — with the keeper off, then on.
 */
async function onTopTests(dir: string, results: Results): Promise<void> {
  const win = getRobotWindow()!;
  const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((f) => fs.existsSync(f));
  if (!edge) {
    results.ontop = "Edge not found";
    return;
  }
  const sf = screen.getPrimaryDisplay().scaleFactor;
  const box = L().box;
  const robotPx = () => {
    const [x, y] = win.getPosition();
    return { cx: Math.round((x + box.x + box.width / 2) * sf), cy: Math.round((y + box.y + box.height * 0.55) * sf) };
  };
  const ps = async (script: string) => (await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000 })).stdout.trim();
  const header = `Add-Type -AssemblyName System.Drawing; Add-Type @"
using System; using System.Runtime.InteropServices;
public class OT { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, IntPtr e);
  public struct POINT { public int X, Y; } }
"@; [void][OT]::SetProcessDpiAwarenessContext([IntPtr](-4));`;
  const clickAt = (x: number, y: number) =>
    ps(`${header} $p = New-Object OT+POINT; [void][OT]::GetCursorPos([ref]$p); [void][OT]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 400;
      [OT]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80; [OT]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero);
      Start-Sleep -Milliseconds 120; [void][OT]::SetCursorPos($p.X, $p.Y)`);
  /** How much of the robot's spot shows the robot's white shell (vs the dark test page). */
  const robotPixels = async (name: string) => {
    const { cx, cy } = robotPx();
    const file = path.join(dir, name);
    const out = await ps(`${header} $b = New-Object System.Drawing.Bitmap 160, 120; $g = [System.Drawing.Graphics]::FromImage($b);
      $g.CopyFromScreen(${cx - 80}, ${cy - 60}, 0, 0, $b.Size); $b.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png);
      $n = 0; for ($x = 0; $x -lt 160; $x += 4) { for ($y = 0; $y -lt 120; $y += 4) { $c = $b.GetPixel($x, $y); if ($c.R -gt 170 -and $c.G -gt 170 -and $c.B -gt 160) { $n++ } } }; $n`);
    return Number(out) || 0;
  };

  const runOnce = async (keeper: boolean) => {
    if (keeper) startStayingOnTop();
    else stopStayingOnTop();
    win.setAlwaysOnTop(true); // the plain setting, as before the fix
    closePanel();
    const profile = path.join(dir, "edge-inprivate");
    const child = execFile(edge, ["--inprivate", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--start-fullscreen",
      "data:text/html,<body style='margin:0;background:%23102030'></body>"]);
    await sleep(4000);
    const atStart = await robotPixels(`ontop-${keeper ? "keeper" : "plain"}-1-start.png`);
    const { cx, cy } = robotPx();
    await clickAt(cx, cy); // click the robot (opens the chat panel)
    await sleep(1200);
    await clickAt(Math.round(screen.getPrimaryDisplay().size.width * sf * 0.6), Math.round(screen.getPrimaryDisplay().size.height * sf * 0.5)); // back to the "video"
    await sleep(2500);
    const afterBack = await robotPixels(`ontop-${keeper ? "keeper" : "plain"}-2-after-click-back.png`);
    child.kill();
    await ps(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'edge-inprivate' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    await sleep(1500);
    fs.rmSync(profile, { recursive: true, force: true });
    closePanel();
    return { atStart, afterBack };
  };

  const plain = await runOnce(false);
  const kept = await runOnce(true);
  results.ontop = {
    "without the keeper (as before): robot pixels at start / after clicking back to the video": plain,
    "with the keeper: robot pixels at start / after clicking back to the video": kept,
    "with the keeper the robot stays visible over a full-screen browser": kept.atStart > 20 && kept.afterBack > 20 ? "pass" : `FAIL ${JSON.stringify(kept)}`,
  };
}

// ----------------------------------------------------------------- activity

/**
 * Matching what you're doing: the robot's side, fed with fake labels (the
 * detection itself is tested in backend/tests/test_activity.py), plus the
 * backend switch and "watching isn't away".
 */
async function activityTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  type R = { expression: string; activity: string; groove: number; clip: string | null; gazeCentre: [number, number]; state: string };
  const robot = getRobotWindow()!;
  const send = async (activity: "none" | "coding" | "watching" | "music", music = activity === "music") => {
    const ev = noteActivity({ type: "activity", text: "", activity, music });
    robot.webContents.send("backend-event", ev);
    await sleep(250);
    return { ev, r: (await sendCommand<R>({ kind: "debug-report" }))! };
  };
  await sendCommand({ kind: "state", state: "idle" });
  await sleep(1500);
  const shots: { label: string; img: NativeImage }[] = [];
  updateSettings({ followActivity: true }); // the robot side only; the backend detector stays off (fake moods below)

  const coding = await send("coding");
  await sleep(1600);
  const codingFace = (await sendCommand<R>({ kind: "debug-report" }))!;
  shots.push({ label: "coding: focused", img: await capture() });

  const watching = await send("watching");
  await sleep(1400);
  const watchingFace = (await sendCommand<R>({ kind: "debug-report" }))!;
  shots.push({ label: "watching: happy, eyes on the video", img: await capture() });

  const music = await send("music");
  await sleep(2600); // the dance, then grooving
  const grooving = (await sendCommand<R>({ kind: "debug-report" }))!;
  for (let i = 0; i < 3; i++) {
    shots.push({ label: `music: grooving ${i + 1}`, img: await capture() });
    await sleep(140);
  }

  const codingWithMusic = await send("coding", true);
  await sleep(2500);
  const gentle = (await sendCommand<R>({ kind: "debug-report" }))!;

  // Watching a video without touching anything isn't "away": no hiding at the edge.
  await send("watching");
  updateSettings({ peekAfterSeconds: 1 });
  setIdleSource(() => 30);
  await sleep(4500);
  const peekedWhileWatching = isPeeking();
  await send("none");
  await waitFor(() => isPeeking(), 8000);
  const peekedWhenAway = isPeeking();
  setIdleSource(() => 0);
  await endPeek();
  updateSettings({ peekAfterSeconds: 300 });
  updateSettings({ followActivity: false });

  // The backend side switches on and off with the setting.
  let backendOn: unknown = null;
  let backendOff: unknown = null;
  if (backend?.ready) {
    updateSettings({ followActivity: true });
    await syncActivity();
    backendOn = (await backend.getJson<{ enabled: boolean }>("/activity"))?.enabled;
    updateSettings({ followActivity: false });
    await syncActivity();
    backendOff = (await backend.getJson<{ enabled: boolean }>("/activity"))?.enabled;
  }
  await send("none");
  await sheet(dir, "activity.png", shots, 5);

  results.activity = {
    "coding: focused face, a nod hello": coding.r.activity === "coding" && codingFace.expression === "focused" && coding.r.clip === "nod" ? "pass" : `FAIL ${JSON.stringify({ coding: coding.r, codingFace })}`,
    "watching: happy face, eyes towards the middle of the screen": watchingFace.expression === "happy" && watching.r.gazeCentre.join() === (watching.ev.look ?? []).join() && (watching.ev.look ?? [0, 0]).some((v) => v !== 0) ? `pass (look ${JSON.stringify(watching.ev.look)})` : `FAIL ${JSON.stringify({ watchingFace, look: watching.ev.look })}`,
    "music: dances, then grooves to the beat": music.r.clip === "dance" && grooving.groove > 0.6 ? `pass (groove ${grooving.groove})` : `FAIL ${JSON.stringify({ clip: music.r.clip, groove: grooving.groove })}`,
    "music while coding: gentle bob, no dance, still focused": codingWithMusic.r.clip !== "dance" && gentle.groove > 0.2 && gentle.groove < 0.5 && gentle.expression === "focused" ? `pass (groove ${gentle.groove})` : `FAIL ${JSON.stringify({ clip: codingWithMusic.r.clip, gentle })}`,
    "watching without touching anything doesn't count as away": !peekedWhileWatching && peekedWhenAway ? "pass" : `FAIL ${JSON.stringify({ peekedWhileWatching, peekedWhenAway })}`,
    "backend follows the setting": backend?.ready ? (backendOn === true && backendOff === false ? "pass" : `FAIL ${JSON.stringify({ backendOn, backendOff })}`) : "backend not running",
  };
}

// ------------------------------------------------------------- conversation

/**
 * Spoken conversation: a reply that expects an answer makes the robot listen
 * again (no wake word); tasks, typed chat and interruptions don't. Replies are
 * stubbed and muted; the "listening" part opens the real microphone briefly.
 */
async function conversationTests(results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.conversation = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true);
  const realChat = backend.chat.bind(backend);
  const realTranscribe = backend.transcribe.bind(backend);
  // Whatever the room sounds like, the answer window "hears" only noise.
  backend.transcribe = async () => "Thank you.";
  let asked = 0;
  const reply = (r: Partial<import("../shared/types").ChatResult>) => {
    backend.chat = async () => {
      asked++;
      // Only the first turn asks something, so a stray noise can't start a loop.
      return asked === 1 ? { ok: true, mood: "curious", ...r } : { ok: true, say: "Okay.", mood: "neutral", follow_up: false };
    };
    asked = 0;
  };
  const report = () => sendCommand<Report & { state: string }>({ kind: "debug-report" });
  try {
    // 1. Bit asks a question out loud -> listens for the answer, then gives up quietly after silence.
    reply({ say: "How was your day?", follow_up: true });
    await runTurn(() => backend, "hi", "voice");
    const spoke = await watchRobot((r) => r.voiceState === "speaking", 8000);
    const listened = await watchRobot((r) => r.voiceState === "listening" && r.listening, 15_000);
    const turnChime = (await sendCommand<{ chime: { kind: string } | null }>({ kind: "debug-report" }))?.chime?.kind;
    const ended = await watchRobot((r) => r.voiceState === "idle" && !r.listening, 25_000); // a noisy room records up to 15 s
    await sleep(200);
    const endChime = (await sendCommand<{ chime: { kind: string } | null }>({ kind: "debug-report" }))?.chime?.kind;
    const followUp = {
      "spoke the question": spoke.elapsed >= 0,
      "then listened without the wake word": listened.elapsed >= 0,
      "silence or noise ended the conversation quietly": ended.elapsed >= 0 && asked === 1,
      "listening started (ms after speaking)": listened.elapsed,
      detail: { endedAfterMs: ended.elapsed, statesSeen: ended.seen, chatTurns: asked },
      chimes: { yourTurn: turnChime, ended: endChime },
    };

    // 2. A music task: done quietly, no speech, no listening.
    reply({ say: "Paused.", quiet: true, follow_up: false });
    await runTurn(() => backend, "pause", "voice");
    const quietRun = await watchRobot((r) => r.voiceState === "speaking" || r.voiceState === "listening", 3000);
    const quietBubble = (await report())?.bubble;

    // 3. A reminder task: confirmed out loud, then no listening.
    reply({ say: "Added it.", follow_up: false });
    await runTurn(() => backend, "remind me", "voice");
    await watchRobot((r) => r.voiceState === "speaking", 8000);
    await watchRobot((r) => r.voiceState === "idle", 10_000);
    const afterTask = await watchRobot((r) => r.voiceState === "listening", 2500);

    // 4. Typed chat never opens the microphone, even if the reply asks something.
    reply({ say: "What are you up to?", follow_up: true });
    await runTurn(() => backend, "hey", "typed");
    await watchRobot((r) => r.voiceState === "speaking", 8000);
    await watchRobot((r) => r.voiceState === "idle", 10_000);
    const afterTyped = await watchRobot((r) => r.voiceState === "listening", 2500);

    // 5. Interrupted mid-question (click / shortcut): don't start listening afterwards.
    reply({ say: "Here is a fairly long question that you will interrupt before I finish asking it, okay?", follow_up: true });
    await runTurn(() => backend, "hi", "voice");
    await watchRobot((r) => r.voiceState === "speaking", 8000);
    await sendCommand({ kind: "stop-speaking" });
    const afterStop = await watchRobot((r) => r.voiceState === "listening", 2500);

    results.conversation = {
      "question -> listens for the answer -> silence/noise ends it quietly": followUp["spoke the question"] && followUp["then listened without the wake word"] && followUp["silence or noise ended the conversation quietly"] ? "pass" : `FAIL ${JSON.stringify(followUp)}`,
      "listening started (ms after it began speaking)": followUp["listening started (ms after speaking)"],
      "chimes: 'your turn' when it starts listening, 'done' when it stops": followUp.chimes.yourTurn === "listen" && followUp.chimes.ended === "done" ? "pass" : `FAIL ${JSON.stringify(followUp.chimes)}`,
      "music task: shown, not spoken, not listening": quietRun.elapsed < 0 && quietBubble === "Paused." ? "pass" : `FAIL ${JSON.stringify({ seen: quietRun.seen, quietBubble })}`,
      "reminder task: spoken, then not listening": afterTask.elapsed < 0 ? "pass" : "FAIL listened after a task",
      "typed chat never opens the mic": afterTyped.elapsed < 0 ? "pass" : "FAIL listened after typed chat",
      "interrupted: doesn't listen afterwards": afterStop.elapsed < 0 ? "pass" : "FAIL listened after being interrupted",
    };
  } finally {
    backend.chat = realChat;
    backend.transcribe = realTranscribe;
    await sendCommand({ kind: "stop-speaking" });
  }
}

// --------------------------------------------------------------------- beat

/** A song at 120 bpm (a fake beat event): the robot's bob should repeat every half second. */
async function beatTests(results: Results): Promise<void> {
  const robot = getRobotWindow()!;
  type R = { bpm: number; pose: { py: number } };
  const send = (ev: object) => robot.webContents.send("backend-event", ev);
  send({ type: "activity", text: "", activity: "music", music: true, look: [0, 0] });
  await sleep(3500); // the hello-dance first, then grooving
  type B = { bpm: number; beatPhase: number; clock: number };
  const measure = async (bpm: number) => {
    send({ type: "beat", text: "", bpm, next_beat_ms: 0 });
    await sleep(100);
    const a = (await sendCommand<B>({ kind: "debug-report" }))!;
    await sleep(1500);
    const b = (await sendCommand<B>({ kind: "debug-report" }))!;
    const rate = (b.beatPhase - a.beatPhase) / (b.clock - a.clock); // radians per second
    const beatsPerMin = Math.round((rate / (2 * Math.PI)) * 60 * 10) / 10;
    // At a beat the bob is at its dip: phase = -90° (mod 360°).
    const period = 60 / bpm;
    const sinceBeat = ((a.beatPhase + Math.PI / 2) / (2 * Math.PI)) * period;
    const offBeatMs = Math.round(Math.abs(((sinceBeat % period) + period) % period) * 1000);
    return { reportedBpm: b.bpm, bobBpm: beatsPerMin, offBeatMs: Math.min(offBeatMs, Math.round(period * 1000) - offBeatMs) };
  };
  const at120 = await measure(120);
  const at90 = await measure(90);
  send({ type: "beat", text: "", bpm: 0 });
  send({ type: "activity", text: "", activity: "none", music: false, look: [0, 0] });
  results.beat = {
    "120 bpm: bobs at 120, dipping on the beat": at120.reportedBpm === 120 && Math.abs(at120.bobBpm - 120) <= 1 && at120.offBeatMs <= 120 ? `pass (${JSON.stringify(at120)})` : `FAIL ${JSON.stringify(at120)}`,
    "90 bpm: bobs at 90": at90.reportedBpm === 90 && Math.abs(at90.bobBpm - 90) <= 1 ? `pass (${JSON.stringify(at90)})` : `FAIL ${JSON.stringify(at90)}`,
  };
}

// ------------------------------------------------------------------- wander

/**
 * Wandering: the perch maths, then for real — perch on a test window (a real
 * screenshot to look at), hop down when it moves, stroll along the bottom.
 */
async function wanderTests(dir: string, results: Results): Promise<void> {
  const robot = getRobotWindow()!;
  await untilQuiet(); // it never wanders off mid-sentence
  const box = L().box;
  const wa = screen.getPrimaryDisplay().workArea;
  const home = robot.getPosition();
  const win = (r: Partial<ForegroundWindow>): ForegroundWindow => ({ x: 400, y: 300, width: 700, height: 450, maximized: false, fullscreen: false, ours: false, ...r });
  const maths = {
    "a maximised window: no": perchSpot(win({ maximized: true })) === null,
    "full screen: no": perchSpot(win({ fullscreen: true })) === null,
    "a tiny window: no": perchSpot(win({ width: 200 })) === null,
    "no room above: no": perchSpot(win({ y: wa.y + 20 })) === null,
    "its own window: no": perchSpot(win({ ours: true })) === null,
    "a normal window: feet on its top edge, left of its buttons": (() => {
      const spot = perchSpot(win({}));
      return !!spot && spot.y + box.y + box.height === 300 + 4 && spot.x + box.x + box.width < 400 + 700 - 150;
    })(),
    "strolls stay on screen": [0.01, 0.5, 0.99].every((r) => {
      const t = strollSpot({ x: wa.x + 10 - box.x, y: 100 }, () => r);
      return t.x + box.x >= wa.x && t.x + box.x + box.width <= wa.x + wa.width && t.y + box.y + box.height <= wa.y + wa.height;
    }),
  };

  // A real window to perch on.
  const target = new BrowserWindow({ x: wa.x + 300, y: wa.y + 340, width: 720, height: 420, show: false, title: "Bit wander test", backgroundColor: "#2b3440", autoHideMenuBar: true });
  await target.loadURL("data:text/html,<body style='background:%232b3440;color:%23ccd;font:20px sans-serif;padding:30px'>A window to sit on</body>");
  target.show();
  target.focus();
  await sleep(700);
  setForegroundSource(async () => ({ ...target.getBounds(), maximized: false, fullscreen: false, ours: false }));
  updateSettings({ wander: true });
  await sendCommand({ kind: "debug-backdrop", on: false });

  let sawWalking = false;
  const watching = (async () => {
    for (let i = 0; i < 60; i++) {
      if ((await sendCommand<{ walking: number }>({ kind: "debug-report" }))?.walking) sawWalking = true;
      await sleep(100);
    }
  })();
  const blocked = wanderBlockers();
  const perched = await wanderTick(Date.now(), "perch");
  await watching;
  await sleep(600);
  const [px, py] = robot.getPosition();
  const feet = py + box.y + box.height;
  const tb = target.getBounds();
  // A real screenshot: the robot sitting on the window.
  const sf = screen.getPrimaryDisplay().scaleFactor;
  const shot = path.join(dir, "wander-perch.png");
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Drawing; Add-Type @"
using System; using System.Runtime.InteropServices;
public class WD { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
"@; [void][WD]::SetProcessDpiAwarenessContext([IntPtr](-4)); $b = New-Object System.Drawing.Bitmap ${Math.round(760 * sf)}, ${Math.round(360 * sf)}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${Math.round((tb.x - 20) * sf)}, ${Math.round((tb.y - 220) * sf)}, 0, 0, $b.Size); $b.Save('${shot}', [System.Drawing.Imaging.ImageFormat]::Png)`], { timeout: 20_000 });

  // The window moves: it hops down.
  target.setPosition(tb.x + 120, tb.y + 60);
  await sleep(300);
  const down = await wanderTick(Date.now());
  await sleep(500);
  const [, dy] = robot.getPosition();

  // A stroll along the bottom.
  const [sx0] = robot.getPosition();
  const strolled = await wanderTick(Date.now(), "stroll");
  await sleep(300);
  const [sx1, sy1] = robot.getPosition();

  target.destroy();
  updateSettings({ wander: false });
  moveWindow(robot, home[0], home[1]);
  results.wander = {
    blockedBy: blocked,
    maths: Object.values(maths).every(Boolean) ? "pass" : `FAIL ${JSON.stringify(maths)}`,
    "perches on your window (feet on its top edge)": perched === "perch" && Math.abs(feet - (tb.y + 4)) <= 3 && px + box.x > tb.x && px + box.x + box.width < tb.x + tb.width ? `pass (screenshot: wander-perch.png)` : `FAIL ${JSON.stringify({ perched, feet, top: tb.y })}`,
    "walks there (stepping animation)": sawWalking ? "pass" : "FAIL never saw it walking",
    "hops down when the window moves": down === "down" && dy + box.y + box.height > tb.y + 200 ? "pass" : `FAIL ${JSON.stringify({ down, dy })}`,
    "strolls along the bottom": strolled === "stroll" && Math.abs(sx1 - sx0) >= 140 && Math.abs(sy1 + box.y + box.height - (wa.y + wa.height - 12)) <= 2 ? "pass" : `FAIL ${JSON.stringify({ strolled, sx0, sx1, sy1 })}`,
  };
}

// -------------------------------------------------------------------- focus

/** A 3-second "focus session": focused look + 🍅, the panel's countdown, the celebration, the break, stopping. */
async function focusTests(results: Results): Promise<void> {
  type R = { focus: boolean; badge: string | null; expression: string; effects: number; bubble: string | null };
  const report = async () => (await sendCommand<R>({ kind: "debug-report" }))!;
  getRobotWindow()!.webContents.setAudioMuted(true);
  await sendCommand({ kind: "badge", emoji: "🎃", label: "Happy Halloween!" });
  openPanel();
  await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
  await sleep(800);
  startFocus(0.05); // 3 seconds
  await sleep(700);
  const during = await report();
  const header = await getPanelWindow()!.webContents.executeJavaScript(`document.getElementById('status').textContent`);
  await sleep(3500);
  const after = await report();
  const onBreak = focusSession();
  stopFocus();
  await sleep(500);
  const stopped = await report();
  closePanel();
  await sendCommand({ kind: "badge", emoji: null, label: "" });
  results.focus = {
    "focused look with a 🍅": during.focus && during.badge === "🍅" ? "pass" : `FAIL ${JSON.stringify(during)}`,
    "the panel shows the time left": /^Focus · \d+ min left$/.test(String(header)) ? `pass ("${header}")` : `FAIL "${header}"`,
    "done: celebrates and starts a break": /Focus session done/.test(String(after.bubble)) && after.effects > 20 && onBreak?.kind === "break" ? "pass" : `FAIL ${JSON.stringify({ after, onBreak })}`,
    "stopping brings back the day's badge": !stopped.focus && stopped.badge === "🎃" && focusSession() === null ? "pass" : `FAIL ${JSON.stringify(stopped)}`,
  };
}

// ----------------------------------------------------------------- check-ins

/** A real morning hello and a real stretch break, on a pretend clock (no AI keys: the hello's template). */
async function checkinTests(results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.checkins = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true);
  updateSettings({ checkIns: true, checkinMemory: { last: 0, morning: "", evening: "", latenight: "", deadline: 0 } });
  const day = new Date();
  const at = (h: number, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  await backend.request("/items", { method: "POST", body: JSON.stringify({ title: "Check-in test task", due_date: ymd, due_time: "23:59" }) });

  const morning = await checkNow(at(8), 5);
  await sleep(500);
  const bubble = (await sendCommand<{ bubble: string | null }>({ kind: "debug-report" }))?.bubble ?? "";
  const log = (await backend.getJson<{ text: string }[]>("/conversation?limit=3")) ?? [];
  const again = await checkNow(at(9), 5);

  // Ninety minutes of coding, checked every four minutes, in the afternoon (once it's done talking).
  await untilQuiet();
  setCheckinActivity("coding");
  let stretch: string | null = null;
  for (let m = 0; m <= 96 && !stretch; m += 4) stretch = await checkNow(at(14, 0 + m), 5);
  await sleep(400);
  const stretchClip = (await sendCommand<{ clip: string | null; bubble: string | null }>({ kind: "debug-report" }))!;
  setCheckinActivity("none");
  updateSettings({ checkIns: false });
  await sendCommand({ kind: "stop-speaking" });

  results.checkins = {
    "morning hello (the number of tasks, not their names)": morning === "morning" && /thing|today/i.test(bubble) && !/Check-in test task/i.test(bubble) ? `pass ("${bubble}")` : `FAIL ${JSON.stringify({ morning, bubble })}`,
    "it's in the conversation (so a reply makes sense)": log.some((m) => m.text === bubble) ? "pass" : `FAIL ${JSON.stringify(log)}`,
    "only once a day": again === null ? "pass" : `FAIL ${again}`,
    "stretch break after 90 minutes of coding": stretch === "stretch" && /\bcod(e|ing)\b/i.test(String(stretchClip.bubble)) ? `pass ("${stretchClip.bubble}")` : `FAIL ${JSON.stringify({ stretch, stretchClip })}`,
  };
}

// --------------------------------------------------------------------- mood

/** Feelings: petting lifts happiness, the robot takes on the mood, the panel shows it, the battery is read. */
async function moodTests(results: Results): Promise<void> {
  setHourSource(() => 14); // the afternoon, whenever this runs (after midnight it's tired, which wins)
  updateSettings({ mood: { happiness: 0.4, boredom: 0.9, at: Date.now() } });
  moodEvent("click"); // pushes the mood to the robot and panel
  await sleep(400);
  const lonely = await sendCommand<{ mood: string }>({ kind: "debug-report" });
  const before = currentMood().happiness;
  ipcPet();
  await sleep(300);
  const after = currentMood().happiness;
  for (let i = 0; i < 8; i++) moodEvent("chat");
  await sleep(400);
  const cheered = await sendCommand<{ mood: string }>({ kind: "debug-report" });
  openPanel();
  await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
  await sleep(900);
  const header = await getPanelWindow()!.webContents.executeJavaScript(`document.getElementById('status').textContent`);
  closePanel();
  const battery = currentMood().battery;
  updateSettings({ mood: { happiness: 0.6, boredom: 0.2, at: Date.now() } });
  // After midnight the live robot is tired, even happy and plugged in.
  setHourSource(() => 2);
  moodEvent("click");
  await sleep(400);
  const night = await sendCommand<{ mood: string }>({ kind: "debug-report" });
  setHourSource(null);
  moodEvent("click");
  results.mood = {
    "after midnight: tired": night?.mood === "tired" ? "pass" : `FAIL ${night?.mood}`,
    "ignored for long: lonely": lonely?.mood === "lonely" ? "pass" : `FAIL ${lonely?.mood}`,
    "petting lifts happiness": after > before ? "pass" : `FAIL ${before} -> ${after}`,
    "chatting cheers it up": ["playful", "happy", "content"].includes(String(cheered?.mood)) ? `pass (${cheered?.mood})` : `FAIL ${cheered?.mood}`,
    "the panel header shows the mood": /Online · /.test(String(header)) ? `pass ("${header}")` : `FAIL "${header}"`,
    "battery read (laptop)": battery ? `pass (${Math.round(battery.level * 100)}%, ${battery.charging ? "charging" : "on battery"})` : "no battery reported (desktop PC, or not supported)",
  };

  function ipcPet(): void {
    // What the robot page sends when you rest the pointer on it.
    getRobotWindow()!.webContents.executeJavaScript(`window.robot.moment("pet"); true`);
  }
}

/** Stop any speech left over from an earlier section and wait until the robot is idle. */
async function untilQuiet(): Promise<void> {
  await sendCommand({ kind: "stop-speaking" });
  for (let i = 0; i < 30; i++) {
    if ((await sendCommand<{ voiceState: string }>({ kind: "debug-report" }))?.voiceState === "idle") break;
    await sleep(100);
  }
  await sleep(200);
}

// ------------------------------------------------------------------ effects

/** Every flourish once, captured mid-flight (a contact sheet to look at), plus moves on request. */
async function effectsTests(dir: string, results: Results): Promise<void> {
  type R = { effects: number; badge: string | null; clip: string | null; state: string; chirp: { kind: string } | null };
  const report = async () => (await sendCommand<R>({ kind: "debug-report" }))!;
  getRobotWindow()!.webContents.setAudioMuted(true); // chirps must not play through your speakers
  await sendCommand({ kind: "debug-backdrop", on: true });
  await sendCommand({ kind: "state", state: "idle" });
  await sleep(600);
  const shots: { label: string; img: NativeImage }[] = [];
  const out: Results = {};

  await sendCommand({ kind: "effect", effect: "confetti" });
  await sleep(350);
  const afterConfetti = await report();
  out.confetti = afterConfetti.effects;
  out.chirpAfterConfetti = afterConfetti.chirp?.kind ?? null;
  shots.push({ label: "task done: confetti", img: await capture() });
  await sleep(2200);

  await sendCommand({ kind: "effect", effect: "heart" });
  await sleep(500);
  out.hearts = (await report()).effects;
  shots.push({ label: "petted: hearts", img: await capture() });
  await sleep(1500);

  // Music: notes rise while it grooves.
  getRobotWindow()!.webContents.send("backend-event", { type: "activity", text: "", activity: "music", music: true, look: [0, 0] });
  await sleep(3200);
  out.notes = (await report()).effects;
  shots.push({ label: "song playing: notes", img: await capture() });
  getRobotWindow()!.webContents.send("backend-event", { type: "activity", text: "", activity: "none", music: false, look: [0, 0] });
  await sleep(2000);

  await sendCommand({ kind: "state", state: "sleepy" });
  await sleep(3000);
  out.zzz = (await report()).effects;
  shots.push({ label: "asleep: Zzz", img: await capture() });
  await sendCommand({ kind: "state", state: "idle" });
  await sleep(2400);

  await sendCommand({ kind: "state", state: "excited" });
  await sleep(300);
  const excited = await report();
  out.sparkles = excited.effects;
  shots.push({ label: "excited: sparkles", img: await capture() });
  await sleep(2600);

  await sendCommand({ kind: "badge", emoji: "🪔", label: "Happy Diwali!" });
  await sleep(400);
  out.badge = (await report()).badge;
  shots.push({ label: "Diwali badge", img: await capture() });
  await sendCommand({ kind: "badge", emoji: null, label: "" });

  // "Do a backflip": the reply plays the move after speaking (speech off here, so straight away).
  await sendCommand({ kind: "speak-enabled", enabled: false });
  await sendCommand({ kind: "reply", say: "Watch this!", mood: "happy", bubble: true, clip: "backflip" });
  await sleep(150);
  const move = await report();
  await sendCommand({ kind: "speak-enabled", enabled: true });
  await sleep(2000);
  await sendCommand({ kind: "debug-backdrop", on: false });
  await sheet(dir, "effects.png", shots, 3);

  results.effects = {
    counts: out,
    "confetti burst": (out.confetti as number) > 30 ? "pass" : `FAIL ${out.confetti}`,
    "hearts": (out.hearts as number) >= 2 ? "pass" : `FAIL ${out.hearts}`,
    "notes while grooving": (out.notes as number) >= 2 ? "pass" : `FAIL ${out.notes}`,
    "Zzz while asleep": (out.zzz as number) >= 1 ? "pass" : `FAIL ${out.zzz}`,
    "excited: a big move with sparkles": (out.sparkles as number) >= 5 && ["jump", "spin", "backflip", "dance"].includes(String(excited.clip)) ? `pass (${excited.clip})` : `FAIL ${JSON.stringify(excited)}`,
    "festival badge": out.badge === "🪔" ? "pass" : `FAIL ${out.badge}`,
    "a task done chirps 'ok!'": out.chirpAfterConfetti === "ok" ? "pass" : `FAIL ${out.chirpAfterConfetti}`,
    "move on request plays after the reply": move.clip === "backflip" ? "pass" : `FAIL ${move.clip}`,
  };
}

// ------------------------------------------------------------------- memory

/**
 * Conversations and long-term memory through the real panel and the real
 * backend (no AI keys in the self-test: replies are the polite "can't reach
 * my brain" line, which still lands in the conversation).
 */
async function memoryTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.memory = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true);
  openPanel();
  await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
  await sleep(900);
  const panel = () => getPanelWindow()!.webContents;
  const js = <T>(code: string) => panel().executeJavaScript(code) as Promise<T>;
  await js(`window.confirm = () => true; true`); // the delete / forget dialogs
  const view = () => js<{ threads: { title: string; selected: boolean }[]; messages: string[]; remembered: string[] }>(`(() => ({
    threads: [...document.querySelectorAll('#thread-select option')].map(o => ({ title: o.textContent, selected: o.selected })),
    messages: [...document.querySelectorAll('.msg')].map(m => m.firstChild ? m.firstChild.textContent : ''),
    remembered: [...document.querySelectorAll('.remembered')].map(r => r.textContent),
  }))()`);
  const typeAndSend = async (text: string) => {
    await js(`document.getElementById('input').value = ${JSON.stringify(text)}; document.getElementById('composer').requestSubmit(); true`);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if ((await view()).messages.length >= 2 && (await view()).messages.at(-2) === text) break;
    }
    await sleep(600);
  };

  await typeAndSend("first conversation hello");
  const v1 = await view();

  await js(`document.getElementById('thread-new').click(); true`);
  await sleep(900);
  const fresh = await view();
  await typeAndSend("planning a goa trip next month");
  await sleep(500);
  const named = await view();

  // Back to the first conversation.
  await js(`(() => { const s = document.getElementById('thread-select'); s.value = [...s.options].find(o => o.textContent !== 'planning a goa trip next month').value; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(1000);
  const back = await view();

  // Delete it: we land in the other one.
  await js(`document.getElementById('thread-delete').click(); true`);
  await sleep(1000);
  const afterDelete = await view();

  // Long-term facts in Settings (added through the backend), forgetting one.
  await backend.send("/memories/exam_date", "PUT", { fact: "The user has an exam on 20 October." });
  await backend.send("/memories/music", "PUT", { fact: "The user likes jazz." });
  await js(`document.querySelector('[data-tab="settings"]').click(); true`);
  await sleep(300);
  await panel().executeJavaScript(`window.panel.facts().then(() => true)`);
  // Reload the list the way the panel does after a turn.
  getPanelWindow()!.webContents.send("panel-event", { type: "threads-changed" });
  await sleep(700);
  const factsBefore = await js<string[]>(`[...document.querySelectorAll('#facts li span')].map(s => s.textContent)`);
  const countText = await js<string>(`document.getElementById('memory-count').textContent`);
  await js(`(() => { const t = document.getElementById('tab-settings'); t.scrollTop = t.scrollHeight; return true; })()`);
  await sleep(200);
  fs.writeFileSync(path.join(dir, "memory-settings.png"), (await panel().capturePage()).toPNG());
  await js(`[...document.querySelectorAll('#facts li')].find(li => li.textContent.includes('jazz')).querySelector('button').click(); true`);
  await sleep(700);
  const factsAfter = (await backend.getJson<{ fact: string }[]>("/memories"))?.map((f) => f.fact) ?? [];

  // A reply that saved something shows a "Remembered" note.
  const realChat = backend.chat.bind(backend);
  backend.chat = async () => ({ ok: true, say: "Nice, jazz it is!", mood: "happy", remembered: ["The user likes jazz."] });
  await js(`document.querySelector('[data-tab="chat"]').click(); true`);
  await runTurn(() => backend, "I like jazz", "typed");
  await sleep(500);
  backend.chat = realChat;
  const note = await view();
  fs.writeFileSync(path.join(dir, "memory-chat.png"), (await panel().capturePage()).toPNG());

  const calNote = await js<string>(`document.getElementById('cal-note').textContent`);

  // Forget everything.
  await js(`document.querySelector('[data-tab="settings"]').click(); document.getElementById('forget').click(); true`);
  await sleep(1200);
  const wiped = { threads: (await backend.getJson<unknown[]>("/threads"))?.length, facts: (await backend.getJson<unknown[]>("/memories"))?.length };
  closePanel();

  results.memory = {
    "a message lands in the current conversation": v1.messages.includes("first conversation hello") ? "pass" : `FAIL ${JSON.stringify(v1)}`,
    "+ New chat starts an empty, selected conversation": fresh.messages.length === 0 && fresh.threads.find((t) => t.selected)?.title === "New chat" ? "pass" : `FAIL ${JSON.stringify(fresh)}`,
    "a new chat is named after its first message": named.threads.some((t) => t.selected && t.title === "planning a goa trip next month") ? "pass" : `FAIL ${JSON.stringify(named.threads)}`,
    "switching shows that conversation's own messages": back.messages.includes("first conversation hello") && !back.messages.includes("planning a goa trip next month") ? "pass" : `FAIL ${JSON.stringify(back)}`,
    "deleting a conversation moves to the other one": afterDelete.threads.length === 1 && afterDelete.messages.includes("planning a goa trip next month") ? "pass" : `FAIL ${JSON.stringify(afterDelete)}`,
    "Settings lists what it remembers": factsBefore.length === 2 && /2 things/.test(countText) ? "pass" : `FAIL ${JSON.stringify({ factsBefore, countText })}`,
    "× forgets one fact": factsAfter.length === 1 && factsAfter[0].includes("exam") ? "pass" : `FAIL ${JSON.stringify(factsAfter)}`,
    "a reply that saved something says so": note.remembered.includes("Remembered: The user likes jazz.") ? "pass" : `FAIL ${JSON.stringify(note.remembered)}`,
    "Forget everything: one empty conversation, no facts": wiped.threads === 1 && wiped.facts === 0 ? "pass" : `FAIL ${JSON.stringify(wiped)}`,
    "Google Calendar row explains the one-time setup": /setup|Not connected|Connected/.test(calNote) ? `pass ("${calNote}")` : `FAIL "${calNote}"`,
  };
}

// ------------------------------------------------------------------- search

/**
 * A turn that needs the web, with stubbed backend replies: "let me look that
 * up" right away, a thinking face while it searches, then the answer, with
 * clickable sources in the panel (the click is recorded, not opened).
 */
async function searchTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.search = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true);
  const realChat = backend.chat.bind(backend);
  const realSearch = backend.search.bind(backend);
  const opened: string[] = [];
  setLinkOpener(async (url) => void opened.push(url));
  try {
    openPanel();
    await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
    await sleep(800);
    // Warm the voice up first (its first sentence after start-up loads the model).
    await sendCommand({ kind: "reply", say: "Okay.", mood: "neutral", bubble: false });
    await watchRobot((r) => r.voiceState === "speaking", 15_000);
    await watchRobot((r) => r.voiceState === "idle", 10_000);
    const lastPanelText = () => getPanelWindow()!.webContents.executeJavaScript(`(() => { const m = [...document.querySelectorAll('.msg')].pop(); return m && m.firstChild ? m.firstChild.textContent : ''; })()`) as Promise<string>;
    backend.chat = async () => ({ ok: true, say: "Let me look that up.", mood: "thinking", search: { query: "weather Mumbai", question: "what's the weather in Mumbai" } });
    let searched = 0;
    backend.search = async () => {
      searched++;
      await sleep(2500); // the web takes a moment
      return { ok: true, say: "It's 31 degrees and hazy in Mumbai.", mood: "happy", details: "- Humidity 60%\n\nSources: [IMD Mumbai](https://mausam.imd.gov.in/mumbai/) · [Bad](https://127.0.0.1/x)" };
    };
    const t0 = Date.now();
    const turn = runTurn(() => backend, "what's the weather in Mumbai", "typed");
    for (let i = 0; i < 50 && !/look that up/.test(await lastPanelText()); i++) await sleep(100);
    const interimMs = Date.now() - t0;
    const interim = { elapsed: /look that up/.test(await lastPanelText()) ? interimMs : -1 };
    const spokeInterim = await watchRobot((r) => r.voiceState === "speaking", 4000);
    const thinking = await watchRobot((r) => r.state === "thinking" && r.voiceState === "thinking", 6000);
    await turn;
    await sleep(600);
    const panel = await getPanelWindow()!.webContents.executeJavaScript(`(() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const last = msgs[msgs.length - 1];
      const links = [...last.querySelectorAll('.details a')].map(a => ({ text: a.textContent, title: a.title }));
      return { texts: msgs.slice(-2).map(m => m.firstChild ? m.firstChild.textContent : ''), links };
    })()`);
    fs.writeFileSync(path.join(dir, "search-panel.png"), (await getPanelWindow()!.webContents.capturePage()).toPNG());
    await getPanelWindow()!.webContents.executeJavaScript(`(() => { const a = document.querySelectorAll('.details a'); a[0].click(); a[1].click(); return true; })()`);
    await sleep(500);

    // "google X": the opened page is Google's results.
    backend.chat = async () => ({ ok: true, say: "Here's Google for \"best biryani\".", mood: "happy", quiet: true, open_url: "https://www.google.com/search?q=best+biryani" });
    await runTurn(() => backend, "google best biryani", "typed");

    results.search = {
      "says it's looking right away (shown, then spoken)": interim.elapsed >= 0 && interimMs < 3000 && spokeInterim.elapsed >= 0 ? `pass (shown in ${interimMs} ms)` : `FAIL ${JSON.stringify({ interim, spokeInterim })}`,
      "thinking face while it searches": thinking.elapsed >= 0 ? "pass" : `FAIL ${JSON.stringify(thinking.seen)}`,
      "then the answer, in the panel after the 'looking' line": searched === 1 && panel.texts[1] === "It's 31 degrees and hazy in Mumbai." && /look that up/.test(panel.texts[0]) ? "pass" : `FAIL ${JSON.stringify({ searched, panel })}`,
      "sources are clickable links (title + site)": panel.links.length === 2 && panel.links[0].text === "IMD Mumbai" && panel.links[0].title === "mausam.imd.gov.in" ? "pass" : `FAIL ${JSON.stringify(panel.links)}`,
      "clicking a source opens it; an unsafe one is refused": opened[0] === "https://mausam.imd.gov.in/mumbai/" && !opened.includes("https://127.0.0.1/x") ? "pass" : `FAIL ${JSON.stringify(opened)}`,
      "'google X' opens Google's results": opened.includes("https://www.google.com/search?q=best+biryani") ? "pass" : `FAIL ${JSON.stringify(opened)}`,
    };
  } finally {
    backend.chat = realChat;
    backend.search = realSearch;
    setLinkOpener(async () => undefined);
    closePanel();
  }
}

// --------------------------------------------------------------------- look

/**
 * "Help me with this", with stubbed AI replies (nothing is sent anywhere):
 * a real screenshot is taken (kept in memory; only a crop of the area behind
 * the robot is saved here), "let me take a look" right away, a thinking face,
 * then the answer. And the robot itself must not be in the picture.
 */
async function lookTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.look = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true);
  const realChat = backend.chat.bind(backend);
  const realLook = backend.look.bind(backend);
  try {
    await untilQuiet();
    openPanel();
    await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
    await sleep(800);
    const panelTexts = () => getPanelWindow()!.webContents.executeJavaScript(`[...document.querySelectorAll('.msg')].slice(-2).map(m => m.firstChild ? m.firstChild.textContent : '')`) as Promise<string[]>;

    // 1. The whole turn.
    backend.chat = async () => ({ ok: true, say: "Let me take a look.", mood: "thinking", look: { question: "help me with this" }, thread_id: "t" });
    const sent: { image: string; mime: string; question: string; size: { width: number; height: number } }[] = [];
    backend.look = async (image, mime, question) => {
      const img = (await import("electron")).nativeImage.createFromBuffer(Buffer.from(image, "base64"));
      sent.push({ image, mime, question, size: img.getSize() });
      await sleep(4000); // the model takes a few seconds
      return { ok: true, say: "That's a KeyError: chemistry isn't in your marks.", mood: "happy", details: "Add it to the dict.\n\n📸 Screenshot sent to Google Gemini (Bit doesn't save it). Say “stop looking” when you're done.", screen_mode: true, follow_up: true };
    };
    const turn = runTurn(() => backend, "help me with this", "typed");
    const thinking = await watchRobot((r) => r.state === "thinking" && r.voiceState === "thinking", 8000);
    await turn;
    await sleep(600);
    const texts = await panelTexts();
    const shot = sent[0];

    // 1b. Then it keeps looking: 👀, the header says so, the next message comes with a fresh screenshot.
    await untilQuiet();
    const header = () => getPanelWindow()!.webContents.executeJavaScript(`document.getElementById('status').textContent`) as Promise<string>;
    const lookingBadge = (await sendCommand<{ badge: string | null }>({ kind: "debug-report" }))?.badge;
    const lookingHeader = await header();
    const chats: (string | undefined)[] = [];
    backend.chat = async (_t, _s, _n, _m, _f, screenshot) => (chats.push(screenshot?.image), { ok: true, say: "Line 3 asks for chemistry.", mood: "happy", screen_mode: true });
    await runTurn(() => backend, "why is it crashing?", "typed");
    backend.chat = async (_t, _s, _n, _m, _f, screenshot) => (chats.push(screenshot?.image), { ok: true, say: "Okay, I stopped looking at your screen.", mood: "happy", screen_mode: false });
    await runTurn(() => backend, "stop looking", "typed");
    await sleep(300);
    const stoppedBadge = (await sendCommand<{ badge: string | null }>({ kind: "debug-report" }))?.badge;
    const stoppedHeader = await header();
    backend.chat = async (_t, _s, _n, _m, _f, screenshot) => (chats.push(screenshot?.image), { ok: true, say: "Hi!", mood: "happy" });
    await runTurn(() => backend, "hello", "typed");
    // Going quiet ends it too.
    keepLooking(300);
    const startedAgain = isLooking();
    await sleep(600);
    const timedOut = !isLooking() && (await sendCommand<{ badge: string | null }>({ kind: "debug-report" }))?.badge !== "👀";
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    // 2. The robot is left out: the area behind it, captured with and without.
    await sendCommand({ kind: "state", state: "idle" });
    await sleep(500);
    const win = getRobotWindow()!;
    const b = win.getBounds();
    const rd = screen.getDisplayMatching(b);
    let excluded: Record<string, unknown> = { skipped: "robot is on another screen than the pointer" };
    if (rd.id === display.id) {
      const scale = rd.scaleFactor || 1;
      const raw = (await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(rd.size.width * scale), height: Math.round(rd.size.height * scale) } }))
        .find((x) => x.display_id === String(rd.id))!.thumbnail;
      const prot = await captureScreen();
      const protImg = (await import("electron")).nativeImage.createFromBuffer(Buffer.from(prot!.image, "base64"));
      const k = protImg.getSize().width / raw.getSize().width; // the screenshot may be scaled down
      const rect = { x: Math.round((b.x - rd.bounds.x) * scale), y: Math.round((b.y - rd.bounds.y) * scale), width: Math.round(b.width * scale), height: Math.round(b.height * scale) };
      const a = raw.crop(rect).resize({ width: 120, height: 120 });
      const c = protImg.crop({ x: Math.round(rect.x * k), y: Math.round(rect.y * k), width: Math.round(rect.width * k), height: Math.round(rect.height * k) }).resize({ width: 120, height: 120 });
      fs.writeFileSync(path.join(dir, "look-behind-robot-visible.png"), a.toPNG());
      fs.writeFileSync(path.join(dir, "look-behind-robot-excluded.png"), c.toPNG());
      const pa = a.toBitmap(), pc = c.toBitmap();
      let differ = 0, dark = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pc[i]) + Math.abs(pa[i + 1] - pc[i + 1]) + Math.abs(pa[i + 2] - pc[i + 2]) > 60) differ++;
        if (pc[i] + pc[i + 1] + pc[i + 2] < 15) dark++;
      }
      const n = pa.length / 4;
      excluded = { differ: +(differ / n).toFixed(3), black: +(dark / n).toFixed(3) };
    }

    // 3. Failures are said plainly.
    backend.chat = async () => ({ ok: true, say: "Let me take a look.", mood: "thinking", look: { question: "help me with this" }, thread_id: "t" });
    backend.look = async () => ({ ok: false, error: "boom" });
    await runTurn(() => backend, "help me with this", "typed");
    await sleep(300);
    const failed = (await panelTexts())[1];
    setScreenGrabber(async () => null);
    let looked = 0;
    backend.look = async () => (looked++, { ok: true, say: "x" });
    await runTurn(() => backend, "help me with this", "typed");
    await sleep(300);
    const noShot = (await panelTexts())[1];

    results.look = {
      "a real screenshot of the screen you're on (JPEG, at most 1920 wide)": shot && shot.mime === "image/jpeg" && shot.image.startsWith("/9j/") && shot.size.width > 0 && shot.size.width <= 1920 && shot.question === "help me with this"
        ? `pass (${shot.size.width}x${shot.size.height}, ${Math.round(shot.image.length * 0.75 / 1024)} kB; screen ${display.size.width}x${display.size.height} @${display.scaleFactor}x)` : `FAIL ${JSON.stringify(shot ? { ...shot, image: shot.image.slice(0, 12) } : null)}`,
      "says it's looking, thinking face, then the answer": sent.length === 1 && thinking.elapsed >= 0 && /take a look/.test(texts[0]) && /KeyError/.test(texts[1]) ? "pass" : `FAIL ${JSON.stringify({ sent: sent.length, thinking, texts })}`,
      "then keeps looking: 👀 on Bit and in the header": lookingBadge === "👀" && /Looking at your screen/.test(lookingHeader) ? "pass" : `FAIL ${JSON.stringify({ lookingBadge, lookingHeader })}`,
      "a follow-up comes with a fresh screenshot": typeof chats[0] === "string" && chats[0]!.startsWith("/9j/") ? "pass" : `FAIL ${JSON.stringify(chats.map((c) => c?.slice(0, 8)))}`,
      "'stop looking' stops it: no 👀, no more screenshots": typeof chats[1] === "string" && chats[2] === undefined && stoppedBadge !== "👀" && !/Looking/.test(stoppedHeader) ? "pass" : `FAIL ${JSON.stringify({ chats: chats.map((c) => c?.slice(0, 8)), stoppedBadge, stoppedHeader })}`,
      "going quiet stops it too": startedAgain && timedOut ? "pass" : `FAIL ${JSON.stringify({ startedAgain, timedOut })}`,
      "Bit itself is not in the screenshot": "skipped" in excluded ? `pass (${excluded.skipped})` : (excluded.differ as number) > 0.02 && (excluded.black as number) < 0.9 ? `pass (${JSON.stringify(excluded)})` : `FAIL ${JSON.stringify(excluded)}`,
      "an AI failure is said plainly": /couldn't look at your screen/.test(failed) ? "pass" : `FAIL ${failed}`,
      "no screenshot: says so, sends nothing": looked === 0 && /couldn't take a screenshot/.test(noShot) ? "pass" : `FAIL ${JSON.stringify({ looked, noShot })}`,
    };
  } finally {
    backend.chat = realChat;
    backend.look = realLook;
    setScreenGrabber(null);
    stopLooking();
    closePanel();
  }
}

// ------------------------------------------------------------------- ignore

/**
 * Background talk heard as a request (a video, other people): no voice, the
 * curious "hm?" look first, then the soft "done" chime, and a note in the chat.
 */
async function ignoreTests(results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.ignore = "backend not running";
    return;
  }
  getRobotWindow()!.webContents.setAudioMuted(true);
  const realChat = backend.chat.bind(backend);
  try {
    await untilQuiet();
    openPanel();
    await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
    await sleep(800);
    backend.chat = async () => ({ ok: true, say: "", mood: "curious", ignored: true, follow_up: false });
    type R = { expression: string; voiceState: string; chime: { kind: string; msAgo: number } | null };
    const report = () => sendCommand<R>({ kind: "debug-report" }) as Promise<R>;
    const before = (await report()).chime;
    void runTurn(() => backend, "Paj Shogu. Paj Shogu. Paj Shogu.", "voice");
    let first: R | null = null;
    for (let i = 0; i < 20 && !(first && first.expression === "curious"); i++) {
      await sleep(25);
      first = await report();
    }
    const spoke = await watchRobot((r) => r.voiceState === "speaking" || r.voiceState === "listening", 1500);
    const after = await report();
    const panel = await getPanelWindow()!.webContents.executeJavaScript(`({ last: (() => { const m = [...document.querySelectorAll('.msg')].pop(); return m && m.firstChild ? m.firstChild.textContent : ''; })(), status: document.getElementById('status').textContent })`) as { last: string; status: string };
    const chimedFirst = first?.chime && (!before || first.chime.msAgo < (before.msAgo ?? 0));
    results.ignore = {
      "the 'hm?' look comes first, before the chime": first?.expression === "curious" && !chimedFirst ? "pass" : `FAIL ${JSON.stringify({ first, before })}`,
      "then the soft 'done' chime": after.chime?.kind === "done" && after.chime.msAgo < 3000 ? "pass" : `FAIL ${JSON.stringify(after.chime)}`,
      "no voice, no listening": spoke.elapsed < 0 ? "pass" : `FAIL ${JSON.stringify(spoke.seen)}`,
      "the chat says why, and isn't stuck on 'Thinking'": /stayed quiet/.test(panel.last) && !/Thinking/.test(panel.status) ? "pass" : `FAIL ${JSON.stringify(panel)}`,
    };
  } finally {
    backend.chat = realChat;
    closePanel();
  }
}

// --------------------------------------------------------------------- wake

/**
 * "Hey Bit" plumbing: setting → backend, muting while talking, and what the
 * robot does with heard/command/cancel events (faked here; the detection
 * itself is tested in backend/tests/test_wake.py). Turning it on opens the
 * microphone for a few seconds; nothing is saved.
 */
async function wakeTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.wake = "backend not running";
    return;
  }
  type Status = { enabled: boolean; listening: boolean; muted: boolean; error: string | null };
  const status = async () => (await backend.getJson<Status>("/wake"))!;
  const robot = getRobotWindow()!;
  robot.webContents.setAudioMuted(true); // test replies must not play through your speakers
  const event = async (ev: import("../shared/types").BackendEvent) => {
    robot.webContents.send("backend-event", ev);
    await handleWakeEvent(ev);
    await sleep(400);
    return sendCommand<{ state: string; bubble: string | null }>({ kind: "debug-report" });
  };
  const realChat = backend.chat.bind(backend);
  const asked: string[] = [];
  try {
    updateSettings({ wakeWord: true });
    await syncWake();
    const on = await status();
    setWakeMuted(true);
    await sleep(300);
    const mutedWhileTalking = (await status()).muted;
    setWakeMuted(false);
    await sleep(300);
    const unmuted = !(await status()).muted;

    backend.chat = async (text) => {
      asked.push(text);
      return { ok: true, say: "It's tea time.", mood: "happy" };
    };
    // How fast the robot reacts once the backend says "it's my name" (pure app-side delay).
    await sendCommand({ kind: "state", state: "idle" });
    await sleep(300);
    robot.webContents.send("backend-event", { type: "wake", phase: "attention", text: "" });
    const perk = await watchRobot((r) => (r as unknown as { expression: string }).expression === "curious", 2000);
    const perkState = await sendCommand<{ state: string; chime: { kind: string; msAgo: number } | null }>({ kind: "debug-report" });
    await sleep(1200);
    robot.webContents.send("backend-event", { type: "wake", phase: "listening", text: "" });
    const shown = await watchRobot((r) => r.state === "listening", 2000);
    const listenReport = await sendCommand<{ chime: { kind: string; msAgo: number } | null }>({ kind: "debug-report" });
    const heard = await event({ type: "wake", phase: "listening", text: "" });
    const thinking = await event({ type: "wake", phase: "command", text: "what time is it" });
    await sleep(1500);
    const replied = await sendCommand<{ bubble: string | null }>({ kind: "debug-report" });
    await sendCommand({ kind: "stop-speaking" });
    await event({ type: "wake", phase: "listening", text: "" });
    const cancelled = await event({ type: "wake", phase: "cancel", text: "" });

    // What the Settings tab looks like with hands-free on and Online recognition picked.
    updateSettings({ sttQuality: "online" });
    openPanel();
    await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
    await sleep(600);
    await getPanelWindow()!.webContents.executeJavaScript(`
      document.querySelector('[data-tab="settings"]').click();
      window.panel.updateSettings({}).then(() => true)`);
    await sleep(500);
    const settingsTab = await getPanelWindow()!.webContents.executeJavaScript(`(() => {
      const s = document.getElementById('tab-settings'); s.scrollTop = 0;
      return { note: document.getElementById('stt-note').textContent, online: document.querySelector('[data-value="online"]').classList.contains('active'),
               wake: document.getElementById('set-wake').checked, overflowX: s.scrollWidth > s.clientWidth };
    })()`);
    fs.writeFileSync(path.join(dir, "settings-tab.png"), (await getPanelWindow()!.webContents.capturePage()).toPNG());
    await getPanelWindow()!.webContents.executeJavaScript(`(() => { const s = document.getElementById('tab-settings'); s.scrollTop = s.scrollHeight; return true; })()`);
    await sleep(200);
    fs.writeFileSync(path.join(dir, "settings-tab-bottom.png"), (await getPanelWindow()!.webContents.capturePage()).toPNG());
    closePanel();
    updateSettings({ sttQuality: "fast" });

    updateSettings({ wakeWord: false });
    await syncWake();
    const off = await status();
    results.wake = {
      "switching on reaches the backend": on.enabled ? "pass" : `FAIL ${JSON.stringify(on)}`,
      "microphone opened (or a clear reason why not)": on.listening || on.error ? `pass (${on.listening ? "listening" : on.error})` : `FAIL ${JSON.stringify(on)}`,
      "muted while the robot talks, unmuted after": mutedWhileTalking && unmuted ? "pass" : `FAIL muted=${mutedWhileTalking} unmuted=${unmuted}`,
      "hearing its name shows the listening face": heard?.state === "listening" ? "pass" : `FAIL ${heard?.state}`,
      "tripwire: quick silent perk-up, no chime, stays idle":
        perk.elapsed >= 0 && perkState?.state === "idle" && perkState?.chime?.kind !== "listen" ? `pass (${perk.elapsed} ms)` : `FAIL ${JSON.stringify({ perk, perkState })}`,
      "confirmed: chime + listening face": shown.elapsed >= 0 && listenReport?.chime?.kind === "listen" ? `pass (face in ${shown.elapsed} ms)` : `FAIL ${JSON.stringify({ shown, chime: listenReport?.chime })}`,
      "robot window is never throttled (animates even when covered)": robot.webContents.getBackgroundThrottling() === false ? "pass" : "FAIL",
      "the command runs as a spoken message and gets a reply": asked[0] === "what time is it" && replied?.bubble === "It's tea time." && thinking?.state !== "listening" ? "pass" : `FAIL ${JSON.stringify({ asked, bubble: replied?.bubble, state: thinking?.state })}`,
      "nothing after the name: back to idle": cancelled?.state === "idle" ? "pass" : `FAIL ${cancelled?.state}`,
      "switching off closes the microphone": !off.enabled && !off.listening ? "pass" : `FAIL ${JSON.stringify(off)}`,
      "settings tab shows hands-free on, Online picked with its privacy note, no sideways scroll":
        settingsTab.wake && settingsTab.online && /Groq/.test(settingsTab.note) && !settingsTab.overflowX ? "pass" : `FAIL ${JSON.stringify(settingsTab)}`,
    };
  } finally {
    backend.chat = realChat;
    updateSettings({ wakeWord: false });
    await syncWake();
  }
}

// --------------------------------------------------------------- unit checks

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
/** A 1920x1080 monitor at (x, y) with a 48 px taskbar at the bottom. */
const mon = (x: number, y: number, taskbar: "bottom" | "left" = "bottom"): DisplayLike => ({
  bounds: rect(x, y, 1920, 1080),
  workArea: taskbar === "bottom" ? rect(x, y, 1920, 1032) : rect(x + 48, y, 1872, 1080),
});

function unitChecks(dir: string, results: Results): void {
  const single = mon(0, 0);
  const left = mon(0, 0);
  const right = mon(1920, 0);
  const top: DisplayLike = { bounds: rect(0, -1080, 1920, 1080), workArea: rect(0, -1080, 1920, 1080) }; // no taskbar
  const bottomScreen = mon(0, 0);
  const lefty = mon(0, 0, "left");

  const edgeCases: [string, Edge, Edge][] = [
    ["single monitor, robot near right", chooseEdge({ x: 1800, y: 900 }, single, [single]), "right"],
    ["single monitor, robot near left", chooseEdge({ x: 150, y: 500 }, single, [single]), "left"],
    ["single monitor, robot low in the middle", chooseEdge({ x: 960, y: 980 }, single, [single]), "bottom"],
    ["two side by side, robot at the seam -> not into the other screen (bottom instead)", chooseEdge({ x: 1850, y: 500 }, left, [left, right]), "bottom"],
    ["two side by side, robot near the outer right edge of the right monitor", chooseEdge({ x: 3800, y: 500 }, right, [left, right]), "right"],
    ["stacked, robot low on the top monitor -> not into the screen below", chooseEdge({ x: 1200, y: -60 }, top, [top, bottomScreen]), "right"],
    ["taskbar on the left: left edge is fine to use", chooseEdge({ x: 100, y: 500 }, lefty, [lefty, mon(-1920, 0)]), "left"],
  ];
  const right2 = peekWindowPosition("right", { x: 1500, y: 600 }, single.workArea, L());
  const bottom2 = peekWindowPosition("bottom", { x: 900, y: 100 }, single.workArea, L());

  // Monitor unplugged: a robot that was on the second screen comes back to the first.
  const onlyPrimary = [{ ...mon(0, 0), id: 1 }] as unknown as Display[];
  const rescued = clampToDisplays({ x: 2500, y: 400 }, onlyPrimary);
  const robotX = rescued.x + L().box.x;

  // Session greeting rules.
  const file = path.join(dir, "session-test.json");
  fs.rmSync(file, { force: true });
  const s1 = { logonId: "S-1-5-5-0-111", bootMs: 1_000_000 };
  const greeted = [
    claimGreeting(file, s1), // first launch this session -> greet
    claimGreeting(file, { ...s1, bootMs: s1.bootMs + 1500 }), // relaunch, uptime jitter -> no
    claimGreeting(file, { logonId: "S-1-5-5-0-222", bootMs: s1.bootMs }), // signed out & in / fast startup -> greet
    claimGreeting(file, { logonId: "S-1-5-5-0-222", bootMs: s1.bootMs + 86_400_000 }), // rebooted -> greet
  ];
  fs.rmSync(file, { force: true });

  results.unit = {
    edges: Object.fromEntries(edgeCases.map(([label, got, want]) => [label, got === want ? "pass" : `FAIL (got ${got})`])),
    "right peek window sits flush with the work area's right edge": right2.x + L().window.width === 1920 ? "pass" : "FAIL",
    "bottom peek window sits flush with the work area's bottom (above taskbar)": bottom2.y + L().window.height === 1032 ? "pass" : "FAIL",
    "monitor removed: robot clamped back onto remaining screen": robotX >= 0 && robotX + L().box.width <= 1920 ? "pass" : "FAIL",
    "greeting: first launch, relaunch, new sign-in, reboot": JSON.stringify(greeted) === JSON.stringify([true, false, true, true]) ? "pass" : `FAIL ${JSON.stringify(greeted)}`,
    "sameSession tolerates uptime jitter": sameSession(s1, { ...s1, bootMs: s1.bootMs - 30_000 }) ? "pass" : "FAIL",
    "links: only https YouTube watch/search pages may be opened": linkChecks(),
    "mood maths": moodChecks(),
    "check-in rules": checkinChecks(),
  };
}

function checkinChecks(): string {
  const wrong: string[] = [];
  const expect = (label: string, ok: boolean) => !ok && wrong.push(label);
  const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m);
  const mem = { last: 0, morning: "", evening: "", latenight: "", deadline: 0 };
  const base = { idleSeconds: 10, codingMinutes: 0, watchingMinutes: 0, busy: false, enabled: true };
  expect("morning hello", decideCheckin({ ...base, now: at(8) }, mem) === "morning");
  expect("only once a day", decideCheckin({ ...base, now: at(9) }, { ...mem, morning: "2026-10-13" }) === null);
  expect("not when you're away", decideCheckin({ ...base, now: at(8), idleSeconds: 900 }, mem) === null);
  expect("not while busy", decideCheckin({ ...base, now: at(8), busy: true }, mem) === null);
  expect("not when switched off", decideCheckin({ ...base, now: at(8), enabled: false }, mem) === null);
  expect("stretch after 90 min coding", decideCheckin({ ...base, now: at(15), codingMinutes: 95 }, { ...mem, morning: "2026-10-13" }) === "stretch");
  expect("not before 90", decideCheckin({ ...base, now: at(15), codingMinutes: 80 }, { ...mem, morning: "2026-10-13" }) === null);
  expect("40 minutes apart", decideCheckin({ ...base, now: at(15), codingMinutes: 95 }, { ...mem, morning: "2026-10-13", last: at(14, 40).getTime() }) === null);
  expect("late night", decideCheckin({ ...base, now: at(1, 30) }, mem) === "latenight");
  expect("deadline nudge after 2h of videos", decideCheckin({ ...base, now: at(16), watchingMinutes: 125 }, { ...mem, morning: "2026-10-13" }) === "deadline");
  expect("evening", decideCheckin({ ...base, now: at(21, 30) }, { ...mem, morning: "2026-10-13" }) === "evening");
  expect("evening says nothing if nothing was done", composeCheckin("evening", { codingMinutes: 0, dueSoon: [], doneToday: 0, name: "Bit" }) === null);
  expect("deadline says nothing without a deadline", composeCheckin("deadline", { codingMinutes: 0, dueSoon: [], doneToday: 0, name: "Bit" }) === null);
  const s = new Stretch();
  const t0 = at(10).getTime();
  for (let m = 0; m <= 60; m += 3) s.update(true, t0 + m * 60_000);
  s.update(false, t0 + 62 * 60_000); // a short break
  s.update(true, t0 + 64 * 60_000);
  expect("a short break doesn't reset coding time", Math.round(s.minutes(t0 + 64 * 60_000)) === 64);
  s.update(false, t0 + 80 * 60_000);
  s.update(true, t0 + 81 * 60_000);
  expect("a long break does", s.minutes(t0 + 81 * 60_000) === 0);
  return wrong.length ? `FAIL ${JSON.stringify(wrong)}` : "pass";
}

function moodChecks(): string {
  const wrong: string[] = [];
  const expect = (label: string, ok: boolean) => !ok && wrong.push(label);
  expect("morning is lively", energyFor(9, null) > 0.8);
  expect("late night is low", energyFor(2, null) < 0.4);
  // Not just "low": after midnight it really is tired, even when happy; 10-12 PM is only calmer.
  expect("after midnight it's tired", moodName({ happiness: 0.9, boredom: 0, energy: energyFor(2, null) }) === "tired");
  expect("before midnight it isn't", moodName({ happiness: 0.9, boredom: 0, energy: energyFor(23, null) }) !== "tired");
  expect("30% battery isn't tired", energyFor(14, { level: 0.3, charging: false }) > 0.3);
  expect("low battery is tired", energyFor(10, { level: 0.1, charging: false }) < 0.3);
  expect("charging isn't tired", energyFor(10, { level: 0.1, charging: true }) > 0.8);
  expect("tired name", moodName({ happiness: 0.9, boredom: 0, energy: 0.2 }) === "tired");
  expect("lonely name", moodName({ happiness: 0.3, boredom: 0.9, energy: 0.8 }) === "lonely");
  expect("bored name", moodName({ happiness: 0.6, boredom: 0.7, energy: 0.8 }) === "bored");
  expect("playful name", moodName({ happiness: 0.8, boredom: 0.1, energy: 0.8 }) === "playful");
  const here = moodTick({ happiness: 0.6, boredom: 0.5 }, 30, "none");
  const away = moodTick({ happiness: 0.6, boredom: 0.5 }, 3600, "none");
  const coding = moodTick({ happiness: 0.6, boredom: 0.5 }, 30, "coding");
  expect("boredom grows while you're here", here.boredom > 0.5);
  expect("not while you're away", away.boredom === 0.5);
  expect("slower while you code", coding.boredom > 0.5 && coding.boredom < here.boredom);
  return wrong.length ? `FAIL ${JSON.stringify(wrong)}` : "pass";
}

function linkChecks(): string {
  const ok = ["https://www.youtube.com/watch?v=jfKfPfyJRdk", "https://www.youtube.com/results?search_query=lofi+music"];
  const bad = [
    "http://www.youtube.com/watch?v=jfKfPfyJRdk", // not https
    "https://youtube.com.evil.example/watch?v=jfKfPfyJRdk",
    "https://www.youtube.com@evil.example/watch?v=jfKfPfyJRdk",
    "https://user:pw@www.youtube.com/watch?v=jfKfPfyJRdk",
    "https://www.youtube.com/redirect?q=https://evil.example",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/watch?v=a%22%3E%3Cscript",
    "https://www.youtube.com/results",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "ms-settings:privacy",
  ];
  ok.push("https://www.google.com/search?q=best+biryani");
  bad.push("https://www.google.com/search", "https://www.google.com/url?q=https://evil.example");
  // Links you click in the chat (search sources): plain https pages only.
  const webOk = ["https://mausam.imd.gov.in/mumbai/?lang=en", "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC"];
  const webBad = ["http://example.com/", "file:///C:/x", "https://localhost:8000/", "https://127.0.0.1/", "https://user:pw@example.com/", "javascript:alert(1)", "https://printer.local/"];
  const wrong = [
    ...ok.filter((u) => !isAllowedLink(u)), ...bad.filter((u) => isAllowedLink(u)),
    ...webOk.filter((u) => !isSafeWebLink(u)), ...webBad.filter((u) => isSafeWebLink(u)),
  ];
  return wrong.length ? `FAIL ${JSON.stringify(wrong)}` : "pass";
}

// ------------------------------------------------------------------- peeking

async function peekTests(dir: string, results: Results): Promise<void> {
  const win = getRobotWindow()!;
  await sendCommand({ kind: "unfreeze" });
  await sendCommand({ kind: "state", state: "idle" });
  await sendCommand({ kind: "debug-backdrop", on: true });
  const home = win.getPosition();
  const out: Results = {};
  const shots: { label: string; img: NativeImage }[] = [];

  for (const edge of ["right", "left", "bottom"] as Edge[]) {
    // Start from somewhere near that edge so the move is short.
    moveWindow(win, home[0], home[1]);
    const t0 = Date.now();
    const ok = await startPeek(edge);
    const ms = Date.now() - t0;
    const [x, y] = win.getPosition();
    const wa = screen.getDisplayNearestPoint({ x: x + 150, y: y + 260 }).workArea;
    const flush =
      edge === "right" ? x + L().window.width === wa.x + wa.width : edge === "left" ? x === wa.x : y + L().window.height === wa.y + wa.height;
    const report = await sendCommand<{ peek: string; shift: { x: number; y: number }; state: string; viewport: unknown }>({ kind: "debug-report" });
    shots.push({ label: `peeking: ${edge}`, img: await capture() });
    const [w, h] = win.getContentSize();
    out[edge] = {
      started: ok,
      ms,
      "window flush with screen edge": flush,
      "window size unchanged by the glide (±1 px rounding)": Math.abs(w - L().window.width) <= 1 && Math.abs(h - L().window.height) <= 1,
      size: `${w}x${h}`,
      renderer: report,
    };

    if (edge === "left") {
      // The visible sliver must still catch a click (which brings it out).
      const vx = 20;
      const hover = await sendCommand<{ overRobot: boolean }>({ kind: "debug-hover", x: vx, y: L().anchor.y });
      shots.push({ label: "peeking: left (hovered)", img: await capture() });
      await sendCommand({ kind: "debug-hover", x: vx, y: L().anchor.y }); // re-assert right before asking Windows
      await sleep(250);
      const page = await sendCommand<{ interactive: boolean }>({ kind: "debug-report" });
      const b = win.getContentBounds();
      const [caught] = await hitTest([screen.dipToScreenPoint({ x: b.x + vx, y: b.y + L().anchor.y })]);
      out.rightClick = {
        "visible part is under the cursor": !!hover?.overRobot,
        "page switched clicks on": !!page?.interactive,
        "visible part catches the click": caught,
        "Windows: robot window not click-through": lastTransparentFlag === "0",
      };
      await sendCommand({ kind: "debug-hover", x: 20, y: 20 });
      await sleep(2000); // let the hover's "peek further" settle back
    }

    await endPeek();
    const [bx, by] = win.getPosition();
    const after = await sendCommand<{ peek: string | null; shift: { x: number; y: number } }>({ kind: "debug-report" });
    out[`${edge} return`] = { "back where it started": bx === home[0] && by === home[1], peekCleared: after?.peek === null, shift: after?.shift };
  }

  // Idle long enough -> it peeks by itself; very long -> sleepy eyes; back -> awake.
  updateSettings({ peekAfterSeconds: 1, sleepyAfterSeconds: 5 });
  setIdleSource(() => 3);
  await waitFor(() => isPeeking(), 10_000);
  const autoPeek = isPeeking();
  setIdleSource(() => 60);
  await sleep(2600);
  const drowsy = await sendCommand<{ expression: string }>({ kind: "debug-report" });
  shots.push({ label: "peeking, away a long time", img: await capture() });
  setIdleSource(() => 0);
  await sleep(2600);
  const awake = await sendCommand<{ expression: string }>({ kind: "debug-report" });
  await endPeek();
  updateSettings({ peekAfterSeconds: 300, sleepyAfterSeconds: 900 });
  out.idle = {
    "peeks by itself after the idle time": autoPeek,
    "sleepy eyes after a long time away": drowsy?.expression === "sleepy",
    "wakes when you're back": awake?.expression !== "sleepy",
  };

  // Idle while not peeking (peeking off) -> sleepy state, then surprised awake.
  updateSettings({ peekEnabled: false, sleepyAfterSeconds: 5 });
  setIdleSource(() => 60);
  await sleep(2600);
  const sleepyState = await sendCommand<{ state: string }>({ kind: "debug-report" });
  shots.push({ label: "sleepy (peeking off)", img: await capture() });
  setIdleSource(() => 0);
  await sleep(2600);
  const woke = await sendCommand<{ state: string }>({ kind: "debug-report" });
  updateSettings({ peekEnabled: true, sleepyAfterSeconds: 900 });
  out.sleepyWhenPeekOff = { "falls asleep": sleepyState?.state === "sleepy", "wakes up": woke?.state !== "sleepy" };

  await sheet(dir, "peeking.png", shots, 4);
  await sendCommand({ kind: "debug-backdrop", on: false });
  moveWindow(win, home[0], home[1]);
  results.peek = out;
}

// ------------------------------------------------------------ system hooks

async function systemTests(results: Results): Promise<void> {
  // Lock / unlock (simulated by emitting the same events Windows sends).
  powerMonitor.emit("lock-screen");
  await sleep(400);
  const locked = await sendCommand<{ paused: boolean }>({ kind: "debug-report" });
  powerMonitor.emit("unlock-screen");
  await sleep(400);
  const unlocked = await sendCommand<{ paused: boolean }>({ kind: "debug-report" });

  // Launch at login: switch on, check Windows' Run key, switch back.
  const before = launchAtLoginEnabled();
  setLaunchAtLogin(true);
  const onSetting = launchAtLoginEnabled();
  const regOn = await runKeyHas("com.desk-robot.bit");
  setLaunchAtLogin(false);
  const offSetting = launchAtLoginEnabled();
  const regOff = await runKeyHas("com.desk-robot.bit");
  if (before) setLaunchAtLogin(true);

  results.system = {
    "screen locked: rendering paused": locked?.paused === true,
    "unlocked: rendering resumed": unlocked?.paused === false,
    "start with Windows on: Electron reports it": onSetting,
    "start with Windows on: Run registry entry exists": regOn,
    "start with Windows off: entry removed": !offSetting && !regOff,
    [`recovery shortcut ${RECOVER_SHORTCUT} registered`]: globalShortcut.isRegistered(RECOVER_SHORTCUT),
  };
}

// ---------------------------------------------------------------------- size

async function sizeTests(dir: string, results: Results): Promise<void> {
  const win = getRobotWindow()!;
  const original = getSettings().size;
  await sendCommand({ kind: "debug-backdrop", on: true });
  await sendCommand({ kind: "freeze", state: "idle", expression: "neutral" });
  const out: Results = {};
  const shots: { label: string; img: NativeImage }[] = [];
  // Start mid-screen, so growing the robot doesn't need clamping back on screen.
  const home = win.getPosition();
  const wa = screen.getPrimaryDisplay().workArea;
  moveWindow(win, wa.x + wa.width / 2 - L().anchor.x, wa.y + wa.height / 2 - L().anchor.y);
  for (const size of ["small", "medium", "large", original] as const) {
    const b0 = win.getBounds();
    const a0 = L().anchor;
    await setSize(size);
    await sendCommand({ kind: "freeze", state: "idle", expression: "neutral" });
    const b = win.getBounds();
    const l = layoutFor(size);
    const page = await sendCommand<{ viewport: { width: number; height: number } }>({ kind: "debug-report" });
    out[size] = {
      window: `${b.width}x${b.height}`,
      "window matches the size's layout (±1 px rounding)": Math.abs(b.width - l.window.width) <= 1 && Math.abs(b.height - l.window.height) <= 1,
      "page re-laid out to match": page?.viewport.width === l.window.width && page?.viewport.height === l.window.height,
      "robot centre stayed put (±1 px)": Math.abs(b.x + l.anchor.x - (b0.x + a0.x)) <= 1 && Math.abs(b.y + l.anchor.y - (b0.y + a0.y)) <= 1,
    };
    if (shots.length < 3) shots.push({ label: size, img: await capture() });
  }
  await sheet(dir, "sizes.png", shots, 3);
  moveWindow(win, home[0], home[1]);
  await sendCommand({ kind: "unfreeze" });
  await sendCommand({ kind: "debug-backdrop", on: false });
  results.size = out;
}

async function runKeyHas(name: string): Promise<boolean> {
  try {
    await execFileAsync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", name], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ captures

async function capture(): Promise<NativeImage> {
  const win = getRobotWindow()!;
  return win.webContents.capturePage();
}

async function pose(cmd: RobotCommand & { kind: "freeze" }): Promise<NativeImage> {
  await sendCommand(cmd);
  return capture();
}

async function captures(dir: string, results: Results): Promise<void> {
  await sendCommand({ kind: "debug-backdrop", on: true });
  const shots: { label: string; img: NativeImage }[] = [];

  for (const expression of EXPRESSIONS) {
    shots.push({ label: expression, img: await pose({ kind: "freeze", state: "idle", expression }) });
  }
  shots.push({ label: "look left", img: await pose({ kind: "freeze", state: "idle", expression: "neutral", lookX: -1, lookY: 0 }) });
  shots.push({ label: "look up-right", img: await pose({ kind: "freeze", state: "idle", expression: "neutral", lookX: 1, lookY: -1 }) });
  for (const state of ["listening", "thinking", "speaking", "sleepy", "working", "notification"] as const) {
    shots.push({ label: `state: ${state}`, img: await pose({ kind: "freeze", state }) });
  }
  await sheet(dir, "expressions.png", shots, 6);

  const moves: { label: string; img: NativeImage }[] = [];
  const frames: [ClipName, number][] = [
    ["bounce", 0.12], ["bounce", 0.3], ["hop", 0.42], ["jump", 0.22], ["jump", 0.55], ["tilt", 0.8],
    ["spin", 0.45], ["spin", 0.7], ["backflip", 0.55], ["backflip", 0.75], ["backflip", 0.95], ["stretch", 1.0],
  ];
  for (const [clip, t] of frames) {
    moves.push({ label: `${clip} @ ${t}s`, img: await pose({ kind: "freeze", state: "idle", expression: "happy", clip, t }) });
  }
  await sheet(dir, "moves.png", moves, 6);

  await sendCommand({ kind: "theme", theme: "silver-purple" });
  const silver = [
    { label: "silver: neutral", img: await pose({ kind: "freeze", state: "idle", expression: "neutral", lookX: -0.6, lookY: -0.5 }) },
    { label: "silver: happy", img: await pose({ kind: "freeze", state: "idle", expression: "happy" }) },
    { label: "silver: focused", img: await pose({ kind: "freeze", state: "idle", expression: "focused" }) },
  ];
  await sendCommand({ kind: "theme", theme: "ivory-cyan" });
  await sheet(dir, "silver.png", silver, 3);

  fs.writeFileSync(path.join(dir, "hero.png"), (await pose({ kind: "freeze", state: "idle", expression: "neutral", lookX: -0.3, lookY: -0.1 })).toPNG());
  results.captures = { expressions: shots.length, moves: moves.length, clipsAvailable: CLIPS.length };
}

async function sheet(dir: string, name: string, shots: { label: string; img: NativeImage }[], columns: number): Promise<void> {
  const dataUrl = await sendCommand<string>(
    { kind: "contact-sheet", images: shots.map((s) => s.img.toDataURL()), labels: shots.map((s) => s.label), columns },
    20_000,
  );
  if (dataUrl) fs.writeFileSync(path.join(dir, name), Buffer.from(dataUrl.split(",")[1], "base64"));
}

// -------------------------------------------------------------- transparency

async function transparency(dir: string, results: Results): Promise<void> {
  await sendCommand({ kind: "debug-backdrop", on: false });
  const img = await pose({ kind: "freeze", state: "idle", expression: "neutral" });
  fs.writeFileSync(path.join(dir, "transparent.png"), img.toPNG());
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const win = getRobotWindow()!;
  const [ww, wh] = win.getContentSize();
  const alphaAt = (x: number, y: number) => {
    const px = Math.round((x / ww) * (width - 1));
    const py = Math.round((y / wh) * (height - 1));
    return bmp[(py * width + px) * 4 + 3];
  };
  results.transparency = {
    cornerAlpha: alphaAt(8, 8),
    aboveRobotAlpha: alphaAt(L().anchor.x, 60),
    robotCentreAlpha: alphaAt(L().anchor.x, L().anchor.y),
    pass: alphaAt(8, 8) === 0 && alphaAt(L().anchor.x, 60) === 0 && alphaAt(L().anchor.x, L().anchor.y) === 255,
  };
}

// ------------------------------------------------------------- click-through

async function hitTest(points: Point[]): Promise<boolean[]> {
  const win = getRobotWindow()!;
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Hit {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
}
"@
"exstyle|" + ([Hit]::GetWindowLong([IntPtr]::new(${hwnd}), -20) -band 0x20)
# Per-monitor aware (-4), so the physical pixels from Electron mean the same
# thing here even when the display scale differs from the sign-in scale.
if (-not [Hit]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { throw "could not become per-monitor DPI aware" }
# Flat x,y list: PowerShell would flatten a one-element array of pairs.
$c = @(${points.map((p) => `${p.x},${p.y}`).join(",")})
for ($i = 0; $i -lt $c.Length; $i += 2) { $pt = New-Object Hit+POINT; $pt.X = $c[$i]; $pt.Y = $c[$i + 1]; $h = [Hit]::GetAncestor([Hit]::WindowFromPoint($pt), 2); $sb = New-Object System.Text.StringBuilder 128; [Hit]::GetClassName($h, $sb, 128) | Out-Null; "$($h.ToInt64())|$($sb.ToString())" }`;
  // Async on purpose: hit-testing sends messages to this window's UI thread.
  const { stdout, stderr } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000 });
  lastRaw += ` ## ${stdout.trim().split(/\r?\n/).join(" ; ")} || points: ${JSON.stringify(points)} || err: ${String(stderr).slice(0, 200)}`;
  const all = stdout.trim().split(/\r?\n/);
  lastTransparentFlag = all[0].split("|")[1];
  const lines = all.slice(1);
  lastHitClasses = lines.map((l) => l.split("|")[1]);
  return lines.map((l) => l.split("|")[0] === hwnd);
}
let lastHitClasses: string[] = [];
let lastTransparentFlag = "";
let lastRaw = "";

async function clickThrough(results: Results): Promise<void> {
  await sendCommand({ kind: "unfreeze" });
  await sendCommand({ kind: "state", state: "idle" });
  const win = getRobotWindow()!;
  const b = win.getContentBounds();
  const toScreen = (x: number, y: number) => screen.dipToScreenPoint({ x: b.x + x, y: b.y + y });
  const empty = toScreen(24, 24);
  const robotPt = toScreen(L().anchor.x, L().anchor.y);

  await sendCommand({ kind: "debug-hover", x: 24, y: 24 });
  await sleep(300);
  const [emptyIdle, robotIdle] = await hitTest([empty, robotPt]);
  const hoverRobot = await sendCommand<{ overRobot: boolean }>({ kind: "debug-hover", x: L().anchor.x, y: L().anchor.y });
  await sleep(300);
  const [, robotHover] = await hitTest([empty, robotPt]);
  await sendCommand({ kind: "debug-hover", x: 24, y: 24 });
  await sleep(300);
  const [emptyAfter] = await hitTest([empty]);

  results.clickThrough = {
    "mouse elsewhere: empty area passes clicks through": !emptyIdle,
    "mouse elsewhere: robot passes clicks through (until hovered)": !robotIdle,
    "hover robot: renderer sees robot under cursor": !!hoverRobot?.overRobot,
    "hover robot: robot catches the click": robotHover,
    hitWindowClass: lastHitClasses[0] + " / " + lastHitClasses[1],
    robotPoint: robotPt,
    raw: lastRaw,
    windowBounds: win.getBounds(),
    "mouse back to empty area: passes through again": !emptyAfter,
  };
}

// ----------------------------------------------------------------------- drag

async function dragTest(results: Results): Promise<void> {
  const win = getRobotWindow()!;
  const [x0, y0] = win.getPosition();
  let cursor = { x: x0 + L().anchor.x, y: y0 + L().anchor.y };
  setCursorSource(() => cursor);

  dragStart();
  for (let i = 1; i <= 10; i++) {
    cursor = { x: x0 + L().anchor.x + 12 * i, y: y0 + L().anchor.y + 6 * i };
    await sleep(25);
  }
  await sleep(100);
  dragEnd();
  const [x1, y1] = win.getPosition();

  // Fling it far off-screen: it must be clamped back onto the display.
  dragStart();
  cursor = { x: 50_000, y: 50_000 };
  await sleep(120);
  dragEnd();
  const [x2, y2] = win.getPosition();
  const wa = screen.getDisplayNearestPoint({ x: x2, y: y2 }).workArea;
  const robot = { x: x2 + L().box.x, y: y2 + L().box.y, r: x2 + L().box.x + L().box.width, b: y2 + L().box.y + L().box.height };
  const inside = robot.x >= wa.x && robot.y >= wa.y && robot.r <= wa.x + wa.width && robot.b <= wa.y + wa.height;

  setCursorSource(() => screen.getCursorScreenPoint());
  moveWindow(win, x0, y0);

  const [sw, sh] = win.getContentSize();
  results.drag = {
    moved: { dx: x1 - x0, dy: y1 - y0, expected: { dx: 120, dy: 60 } },
    "window size unchanged by dragging (±1 px rounding)": Math.abs(sw - L().window.width) <= 1 && Math.abs(sh - L().window.height) <= 1,
    "followed the cursor": x1 - x0 === 120 && y1 - y0 === 60,
    "flung off-screen, robot clamped back inside work area": inside,
  };
}

// ------------------------------------------------------------- tasks (M4)

async function taskTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.tasks = "backend not running";
    return;
  }
  const out: Results = {};
  openPanel();
  await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
  await sleep(800);
  const panel = getPanelWindow()!;
  const js = <T>(code: string) => panel.webContents.executeJavaScript(code) as Promise<T>;
  await js(`window.confirm = () => true; document.querySelector('[data-tab="today"]').click(); true`);
  await sleep(400);

  // Add through the form: a weekday reminder at 18:30.
  await js(`
    document.getElementById('task-title').value = 'Self-test standup';
    document.getElementById('task-time').value = '18:30';
    document.getElementById('task-repeat').value = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    document.getElementById('add-task').requestSubmit(); true`);
  await sleep(1200);
  type Row = { title: string; time: string; repeat: string; done: boolean };
  const rows = () => js<Row[]>(`[...document.querySelectorAll('.task')].map(r => ({
      title: r.querySelector('.what').firstChild.textContent, time: r.querySelector('.time').textContent,
      repeat: (r.querySelector('.repeat') || {}).textContent || '', done: r.classList.contains('done') }))`);
  const added = (await rows()).filter((r) => r.title === "Self-test standup");
  out["form adds a repeating task (shows on the weekdays of the next 7 days)"] = added.length >= 4 && added.every((r) => r.time === "18:30" && r.repeat === "every weekday");

  // The form's date/time pickers can't produce invalid values; anything the
  // backend still rejects must come back as a friendly message, unsaved.
  const bad = await js<{ ok: boolean; error?: string }>(`window.panel.addItem({ title: 'Bad time', date: new Date().toISOString().slice(0, 10), time: '25:00', repeat: null })`);
  out["impossible time is refused with a friendly message"] = !bad.ok && /time/i.test(bad.error ?? "") && !(await rows()).some((r) => r.title === "Bad time");
  out.errorShown = bad.error;

  // Tick the first occurrence off, then untick it.
  await js(`[...document.querySelectorAll('.task')].find(r => r.querySelector('.what').firstChild.textContent === 'Self-test standup').querySelector('.check').click(); true`);
  await sleep(900);
  const afterTick = (await rows()).filter((r) => r.title === "Self-test standup");
  out["tick marks only that day's occurrence done"] = afterTick[0]?.done === true && afterTick.slice(1).every((r) => !r.done);
  fs.writeFileSync(path.join(dir, "today-tab.png"), (await panel.webContents.capturePage()).toPNG());

  // Delete (the confirm dialog is auto-accepted in the test).
  await js(`[...document.querySelectorAll('.task')].find(r => r.querySelector('.what').firstChild.textContent === 'Self-test standup').querySelector('.del').click(); true`);
  await sleep(900);
  out["delete removes the task and all its repeats"] = !(await rows()).some((r) => r.title === "Self-test standup");
  closePanel();

  // Wake from sleep: the backend checks for due reminders straight away.
  const before = (await backend.getJson<{ last_check: string }>("/scheduler/status"))?.last_check;
  await sleep(1100);
  powerMonitor.emit("resume");
  await sleep(600);
  const after = (await backend.getJson<{ last_check: string }>("/scheduler/status"))?.last_check;
  out["waking up triggers an immediate reminder check"] = !!after && after !== before;
  results.tasks = out;
}

// ------------------------------------------------------- backend round trips

async function backendFlow(dir: string, results: Results, backend: Backend | null): Promise<void> {
  if (!backend?.ready) {
    results.backend = "not running";
    return;
  }
  await sendCommand({ kind: "debug-backdrop", on: true });

  // Reminder: a task at the next whole minute. The scheduler checks every
  // 20 s for anything that became due, so it fires within ~80 s.
  const now = new Date();
  const start = new Date(now.getTime() + 60_000);
  start.setSeconds(0, 0);
  const hhmm = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  // Hide at the edge first: the reminder must bring the robot back out.
  const win = getRobotWindow()!;
  const home = win.getPosition();
  await startPeek();
  const peekedBefore = isPeeking();
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await backend.request("/items", { method: "POST", body: JSON.stringify({ title: "Self-test task", due_date: ymd, due_time: hhmm }) });

  let report: { state?: string; bubble?: string | null } | undefined;
  const t0 = Date.now();
  while (Date.now() - t0 < 135_000) {
    report = await sendCommand({ kind: "debug-report" });
    if (report?.state === "notification") break;
    await sleep(500);
  }
  await sleep(700);
  fs.writeFileSync(path.join(dir, "reminder.png"), (await capture()).toPNG());
  const withButtons = await sendCommand<{ bubbleButtons: boolean }>({ kind: "debug-report" });
  const robotWin = getRobotWindow()!;
  await robotWin.webContents.executeJavaScript(`document.querySelector('#bubble-actions [data-action="snooze"]').click(); true`);
  await sleep(1200);
  const snoozed = await sendCommand<{ bubble: string | null }>({ kind: "debug-report" });
  const items = (await backend.getJson<{ title: string; item_id: number; occurrence: string; done: boolean }[]>("/items?days=0")) ?? [];
  const selfTest = items.find((i) => i.title === "Self-test task");
  if (selfTest) await robotWin.webContents.executeJavaScript(`window.robot.reminderAction('done', ${selfTest.item_id}, ${JSON.stringify(selfTest.occurrence)}).then(r => r.ok)`);
  await sleep(500);
  const doneNow = ((await backend.getJson<{ title: string; done: boolean }[]>("/items?days=0")) ?? []).find((i) => i.title === "Self-test task");
  results.backend = {
    reminderSeconds: Math.round((Date.now() - t0) / 1000),
    "reminder put robot in notification state": report?.state === "notification",
    reminderBubble: report?.bubble,
    "was peeking when the reminder came": peekedBefore,
    "reminder bubble has Done / Snooze buttons": !!withButtons?.bubbleButtons,
    "Snooze confirms a new time": /remind you again at \d\d:\d\d/.test(snoozed?.bubble ?? ""),
    "Done marks the task done": doneNow?.done === true,
    "reminder brought it out of hiding, back to where it was": !isPeeking() && win.getPosition()[0] === home[0] && win.getPosition()[1] === home[1],
  };
  await sendCommand({ kind: "debug-backdrop", on: false });
}

// ------------------------------------------------------------ dynamic motion

type Dyn = { state: string; expression: string; clip: string | null; watchingPointer: boolean; gaze: { x: number; y: number }; pose?: Record<string, number> };

async function dynamicTests(dir: string, results: Results): Promise<void> {
  const out: Results = {};
  await sendCommand({ kind: "unfreeze" });
  await sendCommand({ kind: "state", state: "idle" });
  await sendCommand({ kind: "debug-backdrop", on: true });

  // 1. New moves, frozen mid-move, for a look.
  const frames: [ClipName, number][] = [
    ["lookback", 0.7], ["dance", 0.33], ["dance", 0.98], ["doublehop", 0.84], ["bow", 0.8], ["dizzy", 0.4],
    ["sneeze", 0.6], ["sneeze", 0.72], ["peer", 0.9], ["yawn", 1.4], ["wiggle", 0.12], ["shrug", 0.4],
  ];
  const shots: { label: string; img: NativeImage }[] = [];
  for (const [clip, t] of frames) {
    shots.push({ label: `${clip} @ ${t}s`, img: await pose({ kind: "freeze", state: "idle", expression: clip === "yawn" ? "sleepy" : clip === "sneeze" ? "squint" : "happy", clip, t }) });
  }
  shots.push({ label: "wink", img: await pose({ kind: "freeze", state: "idle", expression: "wink" }) });
  await sheet(dir, "moves-new.png", shots, 7);
  await sendCommand({ kind: "unfreeze" });

  // 2. Every move, with random variation, stays numerically sane.
  const bad: string[] = [];
  for (const clip of CLIPS) {
    await sendCommand({ kind: "clip", clip });
    for (let i = 0; i < 4; i++) {
      await sleep(120);
      const r = await sendCommand<Dyn>({ kind: "debug-report" });
      if (r?.pose && Object.values(r.pose).some((v) => !Number.isFinite(v) || Math.abs(v) > 20)) bad.push(clip);
    }
  }
  out["all moves play with finite poses"] = bad.length === 0 ? true : `bad: ${[...new Set(bad)].join(", ")}`;
  await sleep(2500);

  // 3. Pointer awareness, with a simulated pointer (your real mouse isn't touched).
  const win = getRobotWindow()!;
  const [wx, wy] = win.getPosition();
  const cx = wx + L().anchor.x;
  const cy = wy + L().anchor.y;
  let pointer = { x: cx - 320, y: cy - 30 };
  setCursorSource(() => pointer);
  const glide = async (fromX: number, toX: number, y: number) => {
    for (let i = 0; i <= 8; i++) {
      pointer = { x: Math.round(fromX + ((toX - fromX) * i) / 8), y };
      await sleep(110);
    }
  };
  // It may already be bored of your real pointer from earlier steps: wait that out.
  for (let i = 0; i < 60; i++) {
    const r = await sendCommand<{ attn: { boredUntil: number; clock: number } }>({ kind: "debug-report" });
    if (r && r.attn.boredUntil <= r.attn.clock) break;
    await sleep(200);
  }
  await glide(cx - 360, cx - 300, cy - 30);
  await sleep(400);
  const left = await sendCommand<Dyn>({ kind: "debug-report" });
  out.debugLeft = (left as unknown as { attn: unknown })?.attn;
  const leftImg = await capture();
  await glide(cx + 360, cx + 300, cy - 30);
  await sleep(400);
  const right = await sendCommand<Dyn>({ kind: "debug-report" });
  out.debugRight = { ...(right as unknown as { attn: object })?.attn, gaze: right?.gaze, expression: right?.expression, clip: right?.clip };
  const rightImg = await capture();
  await sheet(dir, "attention.png", [{ label: "pointer to the left", img: leftImg }, { label: "pointer to the right", img: rightImg }], 2);

  // Bored: pointer stops moving -> it stops watching within a few seconds.
  await sleep(3800);
  const still = await sendCommand<Dyn>({ kind: "debug-report" });

  // Rushed at: far away, then suddenly close.
  pointer = { x: cx - 600, y: cy };
  await sleep(1500);
  pointer = { x: cx - 80, y: cy };
  let startled = false;
  const startleTrace: unknown[] = [];
  for (let i = 0; i < 10 && !startled; i++) {
    await sleep(60);
    const r = await sendCommand<Dyn & { attn: unknown }>({ kind: "debug-report" });
    startleTrace.push({ clip: r?.clip, attn: r?.attn });
    startled = r?.clip === "startle";
  }
  out.startleTrace = startleTrace.slice(0, 4);
  // Petted: pointer resting on the robot.
  pointer = { x: cx + 3, y: cy + 2 };
  await sleep(150);
  pointer = { x: cx, y: cy };
  let petted = false;
  for (let i = 0; i < 25 && !petted; i++) {
    await sleep(100);
    petted = (await sendCommand<Dyn>({ kind: "debug-report" }))?.clip === "wiggle";
  }

  setCursorSource(() => screen.getCursorScreenPoint());

  out.pointer = {
    "watches the pointer when it moves nearby": !!left?.watchingPointer,
    "looks left when it's left": (left?.gaze.x ?? 0) < -0.4,
    "looks right when it's right": (right?.gaze.x ?? 0) > 0.4,
    gaze: { left: left?.gaze, right: right?.gaze },
    "loses interest when the pointer stops": !still?.watchingPointer,
    "enjoys being petted (wiggles)": petted,
    "startles when the pointer rushes at it": startled,
  };
  await sendCommand({ kind: "debug-backdrop", on: false });
  results.dynamic = out;
}

// --------------------------------------------------------- voice and chat

type Report = { voiceState: string; speaking: boolean; listening: boolean; state: string; bubble: string | null };

/** Poll the robot every 50 ms until `until` is true; returns elapsed ms (or -1) and every voice state seen. */
async function watchRobot(until: (r: Report) => boolean, ms: number): Promise<{ elapsed: number; seen: string[] }> {
  const t0 = Date.now();
  const seen: string[] = [];
  while (Date.now() - t0 < ms) {
    const r = await sendCommand<Report>({ kind: "debug-report" });
    if (r && seen[seen.length - 1] !== r.voiceState) seen.push(r.voiceState);
    if (r && until(r)) return { elapsed: Date.now() - t0, seen };
    await sleep(50);
  }
  return { elapsed: -1, seen };
}

async function panelText(): Promise<{ messages: { role: string; text: string; voice: boolean }[]; status: string }> {
  const panel = getPanelWindow();
  if (!panel) return { messages: [], status: "" };
  return panel.webContents.executeJavaScript(`({
    messages: [...document.querySelectorAll('.msg')].map(m => ({ role: m.classList.contains('user') ? 'user' : 'assistant', text: m.firstChild ? m.firstChild.textContent : '', voice: m.classList.contains('voice') })),
    status: document.getElementById('status').textContent,
  })`);
}

async function voiceTests(dir: string, results: Results, backend: Backend | null): Promise<void> {
  const robot = getRobotWindow()!;
  if (!backend?.ready) {
    results.voice = "backend not running";
    return;
  }
  robot.webContents.setAudioMuted(true); // test speech must not play through your speakers
  const out: Results = {};

  // 1. Typed turn through the real panel. No API keys in the self-test, so the
  //    reply is the polite "can't reach my AI" line, spoken by the local voice.
  openPanel();
  await waitFor(() => !!getPanelWindow() && !getPanelWindow()!.webContents.isLoading(), 10_000);
  await sleep(800);
  await getPanelWindow()!.webContents.executeJavaScript(`
    document.getElementById('input').value = 'hello there';
    document.getElementById('composer').requestSubmit(); true`);
  const typed = await watchRobot((r) => r.voiceState === "speaking", 30_000);
  const panelAfterTyped = await panelText();
  fs.writeFileSync(path.join(dir, "panel.png"), (await getPanelWindow()!.webContents.capturePage()).toPNG());
  out.typed = {
    "panel shows the user's message": panelAfterTyped.messages.some((m) => m.role === "user" && m.text === "hello there"),
    "panel shows the reply": panelAfterTyped.messages.some((m) => m.role === "assistant"),
    "robot spoke the reply (local voice)": typed.elapsed >= 0,
    "voice states seen": typed.seen.join(" → "),
    "send → speaking (ms)": typed.elapsed,
  };

  // 2. Interrupt: stop talking must be immediate.
  const t0 = Date.now();
  await sendCommand({ kind: "stop-speaking" });
  const stopped = await watchRobot((r) => !r.speaking && r.voiceState === "idle", 3000);
  out.interrupt = { "stopped speaking": stopped.elapsed >= 0, "ms until silent": Date.now() - t0 };

  // 3. No overlapping speech: a second reply cuts off the first.
  await sendCommand({ kind: "reply", say: "This is the first thing I am saying, and it is fairly long.", mood: "neutral", bubble: true });
  await watchRobot((r) => r.voiceState === "speaking", 15_000);
  await sendCommand({ kind: "reply", say: "Second!", mood: "happy", bubble: true });
  const second = await sendCommand<Report>({ kind: "debug-report" });
  const done = await watchRobot((r) => r.voiceState === "idle" && !r.speaking, 15_000);
  out.overlap = {
    "bubble switched to the new reply": second?.bubble === "Second!",
    "finished speaking after the second (short) reply (ms)": done.elapsed,
  };

  // 4. Spoken turn: real speech (made with the local voice) goes into the
  //    robot's voice input exactly as a microphone recording would.
  const wav = Buffer.from(await backend.speak("Remind me to study DSA at seven PM.", "af_bella")).toString("base64");
  const before = (await panelText()).messages.length;
  const t1 = Date.now();
  await robot.webContents.executeJavaScript(`
    window.robot.voiceInput(Uint8Array.from(atob(${JSON.stringify(wav)}), c => c.charCodeAt(0)).buffer).then(() => true)`);
  let heard: { role: string; text: string; voice: boolean } | undefined;
  let replied = false;
  while (Date.now() - t1 < 40_000) {
    const p = await panelText();
    heard = p.messages.slice(before).find((m) => m.role === "user" && m.voice);
    replied = !!heard && p.messages.slice(before).some((m) => m.role === "assistant");
    if (replied) break;
    await sleep(200);
  }
  out.spoken = {
    transcript: heard?.text,
    "transcribed correctly": !!heard && /study dsa at 7\s*(pm|p\.m\.)/i.test(heard.text),
    "panel shows it as a voice message": !!heard?.voice,
    "got a reply": replied,
    "speech in → reply on screen (ms)": Date.now() - t1,
  };
  await sendCommand({ kind: "stop-speaking" });

  // 5. Settings round trip from the panel.
  await getPanelWindow()!.webContents.executeJavaScript(`window.panel.updateSettings({ voice: 'af_nicole', sttQuality: 'accurate' }).then(() => true)`);
  out.settings = { "voice + recognition saved": getSettings().voice === "af_nicole" && getSettings().sttQuality === "accurate" };
  await getPanelWindow()!.webContents.executeJavaScript(`window.panel.updateSettings({ voice: 'af_heart', sttQuality: 'fast' }).then(() => true)`);

  // 6. Memory: delete the conversation from the panel.
  const deleted = await getPanelWindow()!.webContents.executeJavaScript(`window.panel.deleteHistory()`);
  await sleep(300);
  const after = await panelText();
  out.memory = { "deleted messages": deleted, "panel cleared": after.messages.length === 0 };

  closePanel();
  robot.webContents.setAudioMuted(false);
  results.voice = out;
}

// -------------------------------------------------------------------- metrics

interface Sample {
  cpu: number;
  memMB: number;
  byType: Record<string, { cpu: number; memMB: number }>;
}

function sampleMetrics(): Sample {
  const byType: Sample["byType"] = {};
  let cpu = 0;
  let mem = 0;
  for (const m of app.getAppMetrics()) {
    const t = (byType[m.type] ??= { cpu: 0, memMB: 0 });
    t.cpu += m.cpu.percentCPUUsage;
    t.memMB += m.memory.workingSetSize / 1024;
    cpu += m.cpu.percentCPUUsage;
    mem += m.memory.workingSetSize / 1024;
  }
  return { cpu, memMB: mem, byType };
}

async function measure(seconds: number, during?: () => void): Promise<Results> {
  sampleMetrics(); // first call primes the CPU counters
  const samples: Sample[] = [];
  for (let i = 0; i < seconds / 2; i++) {
    during?.();
    await sleep(2000);
    samples.push(sampleMetrics());
  }
  const avg = (f: (s: Sample) => number) => Math.round((samples.reduce((a, s) => a + f(s), 0) / samples.length) * 10) / 10;
  const types = Object.keys(samples[0].byType);
  return {
    cpuPercentAvg: avg((s) => s.cpu),
    memoryMBAvg: avg((s) => s.memMB),
    byType: Object.fromEntries(types.map((t) => [t, { cpu: avg((s) => s.byType[t]?.cpu ?? 0), memMB: avg((s) => s.byType[t]?.memMB ?? 0) }])),
  };
}

async function metrics(results: Results): Promise<void> {
  await sendCommand({ kind: "unfreeze" });
  await sendCommand({ kind: "state", state: "idle" });
  await sleep(3000);
  const idle = await measure(20);
  let i = 0;
  const moves: ClipName[] = ["bounce", "spin", "hop", "backflip", "wobble", "jump"];
  const animating = await measure(12, () => void sendCommand({ kind: "clip", clip: moves[i++ % moves.length] }));
  await startPeek("right");
  await sleep(2000);
  const peeking = await measure(12);
  await endPeek();
  results.metrics = { note: "Electron processes only (main, GPU, renderer, utilities); CPU % is of one core", idle, animating, peeking };
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(200);
}
