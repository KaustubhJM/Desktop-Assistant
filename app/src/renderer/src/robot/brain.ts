// brain.ts — the robot's behaviour: a state machine on top of the face and
// body animators, plus everything that makes it feel alive.
//
// States are either persistent (idle, listening, thinking, speaking, sleepy,
// working, peeking) or transient (happy, curious, surprised, excited,
// notification) — a transient state plays over the persistent "base" state
// and hands back to it when it ends.
//
// What keeps it from looking scripted:
//   - every move plays with its own speed, size and left/right mirroring,
//     and sometimes chains into a second small move
//   - idle behaviours are weighted by time of day (lively mornings, yawny nights)
//   - a spring "jiggle" layer: landings, boops and drops wobble and settle
//     instead of stopping dead
//   - it notices your mouse pointer: watches it for a while, gets bored,
//     startles if it rushes at it, and enjoys being "petted" (pointer resting on it)

import type { ClipName, ClipOptions, ExpressionName, RobotStateName } from "../../../shared/types";
import { ClipPlayer, REST, type Pose } from "./clips";
import type { Indicator } from "./eyes";
import { FaceAnimator } from "./expressions";

interface StateDef {
  expression: ExpressionName;
  indicator?: Indicator;
  /** Idle wobble/breathing strength. */
  wobble: number;
  /** Seconds between eye darts, or null to hold the gaze. */
  saccade: [number, number] | null;
  blink: [number, number];
  /** Clip played on entry (a list = pick one at random). */
  enter?: ClipName | ClipName[];
  /** Transient states end after this many seconds. */
  duration?: number;
  /** Repeat a clip every N seconds while in the state. */
  repeat?: [ClipName, number];
}

const STATES: Record<RobotStateName, StateDef> = {
  idle: { expression: "neutral", wobble: 1, saccade: [1.4, 4.2], blink: [2.4, 6] },
  happy: { expression: "happy", wobble: 1.1, saccade: null, blink: [3, 6], enter: ["bounce", "bounce", "wiggle", "doublehop"], duration: 2.4 },
  curious: { expression: "curious", wobble: 0.6, saccade: null, blink: [3, 6], enter: ["tilt", "tilt", "peer"], duration: 3 },
  listening: { expression: "listening", indicator: "listening", wobble: 0.4, saccade: [4, 8], blink: [3, 7] },
  thinking: { expression: "thinking", indicator: "thinking", wobble: 0.5, saccade: [0.9, 1.8], blink: [3, 6] },
  speaking: { expression: "neutral", indicator: "speaking", wobble: 0.8, saccade: [1.5, 3.5], blink: [2.5, 5] },
  sleepy: { expression: "sleepy", indicator: "zzz", wobble: 0.35, saccade: null, blink: [5, 10] },
  surprised: { expression: "surprised", wobble: 0.5, saccade: null, blink: [4, 8], enter: "startle", duration: 1.6 },
  excited: { expression: "excited", wobble: 1.2, saccade: null, blink: [3, 6], enter: ["jump", "spin", "backflip", "dance"], duration: 2.4 },
  working: { expression: "focused", indicator: "working", wobble: 0.3, saccade: [3, 6], blink: [3, 7] },
  notification: { expression: "alert", indicator: "notify", wobble: 0.8, saccade: null, blink: [3, 6], enter: "jump", duration: 12, repeat: ["bounce", 3] },
  peeking: { expression: "neutral", wobble: 0.3, saccade: [1, 2.5], blink: [2, 5] },
};

const BLINK_LEN = 0.22;

/** States that only need the calm (~30 fps) render rate. */
const CALM = new Set<RobotStateName>(["idle", "peeking", "sleepy"]);

/** States where it shouldn't be distracted by the pointer. */
const BUSY_WITH_YOU = new Set<RobotStateName>(["listening", "thinking", "speaking", "notification", "sleepy", "working"]);

const PERSISTENT = new Set<RobotStateName>(["idle", "listening", "thinking", "speaking", "sleepy", "working", "peeking"]);

type Mood = "calm" | "lively" | "tired" | "bored";

interface Behaviour {
  name: string;
  weight: number;
  cooldown: number; // seconds
  mood: Mood;
  run: (b: Brain) => void;
}

/** Things the robot does on its own while idle. Big moves are rare. */
const BEHAVIOURS: Behaviour[] = [
  { name: "glance", weight: 6, cooldown: 3, mood: "calm", run: (b) => b.glance(0.9 * sign(), (Math.random() - 0.6) * 0.6, rand([0.6, 1.3])) },
  { name: "look-around", weight: 4, cooldown: 10, mood: "calm", run: (b) => b.lookAround() },
  { name: "double-blink", weight: 3, cooldown: 6, mood: "calm", run: (b) => b.blinkNow(true) },
  { name: "wobble", weight: 2, cooldown: 15, mood: "calm", run: (b) => b.move("wobble") },
  { name: "lookback", weight: 2, cooldown: 25, mood: "calm", run: (b) => b.lookBack() },
  { name: "nod", weight: 1.5, cooldown: 20, mood: "calm", run: (b) => b.move("nod") },
  { name: "curious-tilt", weight: 2, cooldown: 25, mood: "calm", run: (b) => b.setState("curious") },
  { name: "peer", weight: 1.2, cooldown: 40, mood: "calm", run: (b) => b.flash("focused", 1.9, "peer") },
  { name: "shrug", weight: 0.8, cooldown: 60, mood: "calm", run: (b) => b.flash("content", 1.1, "shrug") },
  { name: "shiver", weight: 0.5, cooldown: 120, mood: "calm", run: (b) => b.flash("squint", 0.8, "shiver") },
  { name: "happy-bounce", weight: 1.5, cooldown: 35, mood: "lively", run: (b) => b.setState("happy") },
  { name: "wiggle", weight: 1.5, cooldown: 30, mood: "lively", run: (b) => b.flash("happy", 1, "wiggle") },
  { name: "hop", weight: 1, cooldown: 50, mood: "lively", run: (b) => b.flash("happy", 1.2, "hop") },
  { name: "doublehop", weight: 0.8, cooldown: 90, mood: "lively", run: (b) => b.flash("excited", 1.4, "doublehop") },
  { name: "dance", weight: 0.5, cooldown: 240, mood: "lively", run: (b) => b.flash("happy", 2.6, "dance") },
  { name: "spin", weight: 0.5, cooldown: 150, mood: "lively", run: (b) => b.flash("excited", 1.6, "spin") },
  { name: "backflip", weight: 0.2, cooldown: 400, mood: "lively", run: (b) => b.flash("excited", 1.8, "backflip") },
  { name: "bow", weight: 0.4, cooldown: 300, mood: "lively", run: (b) => b.flash("content", 1.7, "bow") },
  { name: "stretch", weight: 1.2, cooldown: 60, mood: "tired", run: (b) => b.flash("content", 2, "stretch") },
  { name: "yawn", weight: 1, cooldown: 180, mood: "tired", run: (b) => b.flash("sleepy", 2.6, "yawn") },
  { name: "sneeze", weight: 0.35, cooldown: 400, mood: "lively", run: (b) => b.flash("squint", 1.35, "sneeze") },
  // Bored or lonely: tries to get your attention (looks at you, hops, beeps).
  { name: "attention", weight: 1, cooldown: 45, mood: "bored", run: (b) => b.seekAttention() },
];

/** What you're doing (from the backend): changes its resting face and which idle moves it picks. */
export type Activity = "none" | "coding" | "watching" | "music";

interface ActivityStyle {
  face: ExpressionName;
  /** Weight multipliers by behaviour mood, plus per-behaviour boosts. */
  calm: number;
  lively: number;
  tired: number;
  boost?: Record<string, number>;
  /** Longer (>1) or shorter (<1) pauses between idle moves, and between repeats of the same move. */
  pause: number;
  cooldown?: number;
}

const ACTIVITY: Record<Activity, ActivityStyle> = {
  none: { face: "neutral", calm: 1, lively: 1, tired: 1, pause: 1 },
  // You're concentrating: small, calm, less often. It "reads along" (peer).
  coding: { face: "focused", calm: 0.8, lively: 0, tired: 0.3, pause: 2, boost: { peer: 3, glance: 0.5, "look-around": 0.3, lookback: 0.3 } },
  // Watching with you: eyes on the video, few glances away, an occasional happy wiggle.
  watching: { face: "happy", calm: 0.7, lively: 0.25, tired: 0.5, pause: 1.6, boost: { glance: 0.3, "look-around": 0.2, lookback: 0.2, "happy-bounce": 2, wiggle: 2 } },
  // A song: dance party.
  music: {
    face: "happy", calm: 0.5, lively: 3, tired: 0.1, pause: 0.6, cooldown: 0.5,
    boost: { dance: 4, wiggle: 2, "happy-bounce": 2, hop: 1.5, doublehop: 1.5, spin: 1.5, glance: 0.5 },
  },
};

/** How it feels (main/mood.ts) shifts which idle moves it picks, like ACTIVITY does. */
export type MoodName = "playful" | "happy" | "content" | "bored" | "lonely" | "tired";

const MOOD_STYLE: Record<MoodName, { face: ExpressionName; calm: number; lively: number; tired: number; bored: number; pause: number }> = {
  playful: { face: "happy", calm: 1, lively: 1.7, tired: 0.4, bored: 0, pause: 0.8 },
  happy: { face: "happy", calm: 1, lively: 1.25, tired: 0.7, bored: 0, pause: 0.95 },
  content: { face: "neutral", calm: 1, lively: 1, tired: 1, bored: 0, pause: 1 },
  bored: { face: "neutral", calm: 1.1, lively: 0.6, tired: 1.2, bored: 1, pause: 0.9 },
  lonely: { face: "neutral", calm: 1, lively: 0.4, tired: 1, bored: 2.2, pause: 0.85 },
  tired: { face: "sleepy", calm: 0.8, lively: 0.3, tired: 2.5, bored: 0, pause: 1.5 },
};

/** Small moves that can follow another one ("and a little wiggle"). */
const CHAINS: ClipName[] = ["wiggle", "nod", "shrug", "hop", "bounce"];

/** How lively the robot is right now: mornings bouncy, late nights sleepy. */
function energyNow(hour = new Date().getHours()): { lively: number; tired: number } {
  if (hour >= 7 && hour < 11) return { lively: 1.4, tired: 0.5 };
  if (hour >= 11 && hour < 17) return { lively: 1.0, tired: 0.8 };
  if (hour >= 17 && hour < 22) return { lively: 0.85, tired: 1.3 };
  return { lively: 0.5, tired: 2.6 };
}

/** Random per-play variation so no move looks the same twice. */
export function variation(mirror = true): ClipOptions {
  return { speed: rand([0.86, 1.18]), amp: rand([0.78, 1.22]), mirror: mirror ? sign() : 1 };
}

type Spring = { x: number; v: number };

export class Brain {
  readonly face = new FaceAnimator();
  readonly clips = new ClipPlayer();
  state: RobotStateName = "idle";
  base: RobotStateName = "idle";
  indicator: Indicator = "none";
  indicatorPhase = 0;
  /** 0..1 level for speaking/listening visuals (set from outside). */
  level = 0;
  dragging = false;
  /** Horizontal drag velocity (px/s), swings the body while carried. */
  dragVelocity = 0;
  frozen = false;
  /** Eyes follow your mouse pointer (setting). */
  followMouse = true;
  private drowsy = false;
  private speakingFace: ExpressionName = "neutral";

  private clock = 0;
  private stateEnds = Infinity;
  private nextRepeat = Infinity;
  private nextBlink = 1.5;
  private blinks: number[] = [];
  private nextSaccade = 1;
  private nextBehaviour = 6;
  /** Moments worth a visual flourish (effects.ts): petted, dizzy, excited, startled. */
  onMoment: (moment: "pet" | "dizzy" | "excited" | "startle" | "attention") => void = () => undefined;
  activity: Activity = "none";
  mood: MoodName = "content";
  /** A focus session: calm and focused, like coding mode. */
  focus = false;
  /** The song's beat (beat.py): period in seconds, a beat time on this clock, when we last heard. */
  private beat: { period: number; t0: number; heard: number } | null = null;
  /** The bob's phase right now (radians; for the self-test). */
  beatPhase = 0;
  /** This brain's clock (for the self-test). */
  get now(): number {
    return this.clock;
  }
  get bpm(): number {
    return this.beat && this.clock - this.beat.heard < 8 ? Math.round(60 / this.beat.period) : 0;
  }
  /** Wandering: stepping along (1 = right, -1 = left), 0 = standing. */
  walking: 0 | 1 | -1 = 0;
  private music = false; // a song is playing (it grooves, even while you code)
  groove = 0; // eased 0..1
  private lastBehaviour = "";
  private cooldowns = new Map<string, number>();
  private gazeQueue: { at: number; x: number; y: number }[] = [];
  private flashUntil = -1;
  private wobble = 1;
  private swing = 0;
  private headYaw = 0;
  private gazeCentre = { x: 0, y: 0 };
  private leanTarget = { ry: 0, rz: 0 };
  private lean = { ry: 0, rz: 0 };
  private chain: { at: number; clip: ClipName } | null = null;
  private dragEnergy = 0;

  // Spring "jiggle" layer: kicked by landings, boops and drops.
  private jig: Record<"rz" | "rx" | "sy", Spring> = { rz: { x: 0, v: 0 }, rx: { x: 0, v: 0 }, sy: { x: 0, v: 0 } };
  private prevPy = 0;
  private prevVy = 0;

  // Mouse pointer awareness.
  private att = {
    dx: 0, dy: 0, dist: 9999, over: false,
    lastMove: -99,
    interested: false, since: 0, patience: 6, boredUntil: 0,
    hoverSince: -1, lastStartle: -99, lastPet: -99,
  };
  private lookLean = { rz: 0, rx: 0 };
  private lookLeanNow = { rz: 0, rx: 0 };

  /** Final body pose this frame (clip + procedural layers). */
  pose: Pose = { ...REST };

  constructor() {
    this.applyState("idle");
  }

  setState(state: RobotStateName): void {
    if (PERSISTENT.has(state)) this.base = state;
    this.applyState(state);
  }

  /** End a transient state now (e.g. a reminder was dismissed). */
  settle(): void {
    if (!PERSISTENT.has(this.state)) this.applyState(this.base);
  }

  /** Play a clip exactly as authored (tray menu, self-test). */
  playClip(name: ClipName, opts: ClipOptions = {}): void {
    this.clips.play(name, opts);
  }

  /** Play a clip with natural variation, sometimes chaining a small follow-up. */
  move(name: ClipName, chainChance = 0.15): void {
    this.clips.play(name, variation(), () => {
      if (Math.random() < chainChance && this.state === "idle") {
        this.chain = { at: this.clock + rand([0.15, 0.5]), clip: CHAINS[Math.floor(Math.random() * CHAINS.length)] };
      }
    });
  }

  /** Show an expression briefly, optionally with a (varied) clip, without changing state. */
  flash(expression: ExpressionName, seconds: number, clip?: ClipName): void {
    this.face.setExpression(expression);
    this.flashUntil = this.clock + seconds;
    if (clip) this.move(clip);
  }

  glance(x: number, y: number, hold: number): void {
    this.face.gazeX = x;
    this.face.gazeY = y;
    this.gazeQueue = [{ at: this.clock + hold, ...this.gazeCentre }];
    this.nextSaccade = this.clock + hold + 1;
  }

  lookAround(): void {
    const s = sign();
    this.face.gazeX = 0.9 * s;
    this.face.gazeY = -0.1;
    this.gazeQueue = [
      { at: this.clock + rand([0.7, 1.1]), x: -0.9 * s, y: -0.1 },
      { at: this.clock + rand([1.7, 2.3]), ...this.gazeCentre },
    ];
    this.nextSaccade = this.clock + 3;
  }

  /** Turn to look behind, eyes leading the way. */
  lookBack(): void {
    const opts = variation();
    this.clips.play("lookback", opts);
    this.glance(0.95 * (opts.mirror ?? 1), -0.15, 1.1);
  }

  blinkNow(twice = false): void {
    this.blinks = twice ? [this.clock, this.clock + 0.3] : [this.clock];
  }

  /** Nudge the spring layer (positive rz tips left, negative sy squashes). */
  kick(channel: "rz" | "rx" | "sy", velocity: number): void {
    this.jig[channel].v += velocity;
  }

  /** You clicked it: a varied little reaction. */
  boop(): void {
    const reactions: [ExpressionName, number, ClipName][] = [
      ["squint", 0.5, "startle"],
      ["wink", 0.9, "wiggle"],
      ["happy", 1.0, "shrug"],
      ["surprised", 0.8, "bounce"],
      ["content", 0.9, "nod"],
    ];
    const [face, secs, clip] = reactions[Math.floor(Math.random() * reactions.length)];
    this.flash(face, secs, clip);
    this.kick("rz", (Math.random() - 0.5) * 2.4);
    this.kick("sy", -1.2);
  }

  /** Being carried: count how much it's been shaken about. */
  carried(dt: number): void {
    this.dragEnergy += Math.abs(this.dragVelocity) * dt;
  }

  /** Put down after a drag: a soft landing, or dizzy if it was swung around a lot. */
  dropped(): void {
    const shaken = this.dragEnergy > 1400;
    this.dragEnergy = 0;
    this.kick("rz", -this.swing * 6);
    if (shaken) {
      this.flash("squint", 2.2, "dizzy");
      this.onMoment("dizzy");
    }
    else this.flash("happy", 1, "land");
  }

  /**
   * Where your pointer is, relative to the robot's centre (DIPs), ~10 times a
   * second. `over` = it's resting on the robot; `closing` = approach speed, px/s.
   */
  attention(dx: number, dy: number, dist: number, over: boolean, closing: number): void {
    const a = this.att;
    const now = this.clock;
    const moved = Math.hypot(dx - a.dx, dy - a.dy) > 3;
    a.dx = dx;
    a.dy = dy;
    a.dist = dist;
    a.over = over;
    if (moved) a.lastMove = now;
    this.lastClosing = closing;
    if (!this.followMouse || this.frozen || !this.attentive) {
      a.hoverSince = -1;
      return;
    }

    // Rushed at: a little startle (not too often).
    if (dist < 170 && closing > 1100 && now - a.lastStartle > 8) {
      a.lastStartle = now;
      this.flash("surprised", 0.8, "startle");
      this.kick("rx", -1.5);
      this.onMoment("startle");
    }

    // Pointer resting on it = being petted (timed in update(): a resting
    // pointer sends no further updates).
    if (over && a.hoverSince < 0) a.hoverSince = now;
    if (!over) a.hoverSince = -1;

    if (moved && dist < 650 && now >= a.boredUntil && !a.interested) {
      a.interested = true;
      a.since = now;
      a.patience = rand([4, 10]);
    }
  }

  /** It pays attention to your pointer unless it's busy with you (or asleep). */
  private get attentive(): boolean {
    return !BUSY_WITH_YOU.has(this.state) && !this.dragging;
  }

  /** True while something is visibly moving fast (render at full rate). */
  get busy(): boolean {
    const jiggling = Math.abs(this.jig.rz.x) + Math.abs(this.jig.rx.x) + Math.abs(this.jig.sy.x) > 0.002;
    return (
      this.clips.active || this.dragging || this.blinks.length > 0 || !CALM.has(this.state) ||
      this.flashUntil > this.clock || jiggling || this.att.interested
    );
  }

  /** Sleepy eyes while peeking (you've been away a long time). */
  setDrowsy(on: boolean): void {
    this.drowsy = on;
    if (this.flashUntil < 0) this.face.setExpression(this.expressionFor(this.state));
  }

  /** The face to wear while speaking (follows the reply's mood). */
  setSpeakingFace(expression: ExpressionName): void {
    this.speakingFace = expression;
    if (this.state === "speaking" && this.flashUntil < 0) this.face.setExpression(expression);
  }

  private expressionFor(state: RobotStateName): ExpressionName {
    if (state === "speaking") return this.speakingFace;
    if (state === "idle") return this.focus ? "focused" : this.activity !== "none" ? ACTIVITY[this.activity].face : MOOD_STYLE[this.mood].face;
    return state === "peeking" && this.drowsy ? "sleepy" : STATES[state].expression;
  }

  /**
   * What you're doing. Returns true if it changed. With `react`, greets the
   * change with a move: a focused nod, a happy bounce, or a dance.
   */
  setActivity(activity: Activity, music: boolean, react: boolean): boolean {
    const changed = activity !== this.activity;
    this.activity = activity;
    this.music = music;
    if (!changed) return false;
    if (this.state === "idle" && this.flashUntil < 0) this.face.setExpression(this.expressionFor("idle"));
    if (react && this.state === "idle") {
      if (activity === "coding") this.flash("focused", 1.4, "nod");
      else if (activity === "watching") this.flash("happy", 1.2, "bounce");
      else if (activity === "music") this.flash("happy", 2.6, "dance");
    }
    return true;
  }

  /** The music's tempo and where the next beat lands (0 bpm: no steady beat). */
  setBeat(bpm: number, nextBeatMs: number): void {
    this.beat = bpm > 0 ? { period: 60 / bpm, t0: this.clock + nextBeatMs / 1000, heard: this.clock } : null;
  }

  setFocus(on: boolean): void {
    this.focus = on;
    if (this.state === "idle" && this.flashUntil < 0) this.face.setExpression(this.expressionFor("idle"));
  }

  /** How it feels now (main/mood.ts). */
  setMood(mood: MoodName): void {
    if (mood === this.mood || !(mood in MOOD_STYLE)) return;
    this.mood = mood;
    if (this.state === "idle" && this.flashUntil < 0) this.face.setExpression(this.expressionFor("idle"));
  }

  /** Bored: look right at you, hop, beep. */
  seekAttention(): void {
    this.glance(this.gazeCentre.x * 0.3, 0.1, 1.6);
    this.flash("curious", 1.4, "hop");
    this.onMoment("attention");
  }

  /** Where the eyes rest and return to (peeking looks back at the screen). */
  setGazeCentre(x: number, y: number): void {
    this.gazeCentre = { x, y };
    this.face.gazeX = x;
    this.face.gazeY = y;
  }

  /** Wandering: step along facing the way it goes (turned a little, eyes leading). */
  setWalking(dir: 0 | 1 | -1): void {
    this.walking = dir;
    this.setLean(dir * 0.4, 0);
    if (dir) this.glance(dir * 0.8, 0.1, 0.5);
    else this.gazeQueue = [{ at: this.clock + 0.2, ...this.gazeCentre }];
  }

  /** Extra body lean (peeking leans out from behind the edge). */
  setLean(ry: number, rz: number): void {
    this.leanTarget = { ry, rz };
  }

  /** Self-test: hold a pose so it can be captured. */
  freeze(opts: { state?: RobotStateName; expression?: ExpressionName; clip?: ClipName; t?: number; lookX?: number; lookY?: number }): void {
    this.frozen = true;
    if (opts.state) this.applyState(opts.state, false);
    if (opts.expression) this.face.setExpression(opts.expression);
    this.face.gazeX = opts.lookX ?? 0;
    this.face.gazeY = opts.lookY ?? 0;
    this.face.face.blink = 0;
    this.blinks = [];
    for (const s of Object.values(this.jig)) s.x = s.v = 0;
    if (opts.clip) this.clips.seek(opts.clip, opts.t ?? 0);
    else this.clips.stop();
    this.face.snap();
    this.pose = { ...this.clips.pose };
    this.indicatorPhase = 0.4;
    this.level = 0.6;
  }

  unfreeze(): void {
    this.frozen = false;
    this.clips.stop();
    this.applyState(this.base);
  }

  private lastClosing = 0;

  /** Self-test / debug: attention internals. */
  get attentionDebug(): Record<string, unknown> {
    const a = this.att;
    return { clock: +this.clock.toFixed(2), state: this.state, attentive: this.attentive, interested: a.interested, boredUntil: +a.boredUntil.toFixed(2), lastMove: +a.lastMove.toFixed(2), dist: Math.round(a.dist), closing: Math.round(this.lastClosing), lastStartle: +a.lastStartle.toFixed(2) };
  }

  /** Self-test / debug: is it currently watching the pointer? */
  get watchingPointer(): boolean {
    return this.att.interested;
  }

  update(dt: number): boolean {
    if (this.frozen) return this.face.step(0);
    this.clock += dt;
    const def = STATES[this.state];

    // Transient state ending, repeats, chained follow-up moves.
    if (this.clock >= this.stateEnds) this.applyState(this.base);
    if (this.clock >= this.nextRepeat && def.repeat) {
      this.clips.play(def.repeat[0], variation());
      this.nextRepeat = this.clock + def.repeat[1] * rand([0.85, 1.2]);
    }
    if (this.walking && !this.clips.active) this.clips.play("walk", { speed: 1, amp: 1, mirror: this.walking });
    if (this.chain && this.clock >= this.chain.at && !this.clips.active) {
      this.clips.play(this.chain.clip, variation());
      this.chain = null;
    }
    if (this.flashUntil > 0 && this.clock >= this.flashUntil) {
      this.flashUntil = -1;
      this.face.setExpression(this.expressionFor(this.state));
    }

    this.updateBlink(def);
    const watching = this.updateAttention();
    if (!watching) this.updateGaze(def);
    if (this.state === "idle" && !this.dragging && !watching) this.updateBehaviours();

    // Speaking / listening drive the eyes and the indicator.
    this.indicatorPhase += dt;
    const talking = this.state === "speaking";
    this.face.heightPulse = talking ? -0.12 * this.level : 0;
    this.face.brightnessPulse = talking || this.state === "listening" ? 0.15 * this.level : 0;

    if (this.dragging) this.carried(dt);
    this.clips.update(dt);
    this.updatePose(dt, def);
    return this.face.step(dt);
  }

  /** Follow the pointer with eyes (and a little lean) while interested. */
  private updateAttention(): boolean {
    const a = this.att;
    if (a.over && a.hoverSince >= 0 && this.clock - a.hoverSince > 1.3 && this.clock - a.lastPet > 10 && this.attentive && this.followMouse) {
      a.lastPet = this.clock;
      this.flash("content", 1.8, "wiggle"); // being petted
      this.onMoment("pet");
    }
    if (!a.interested) {
      this.lookLean = { rz: 0, rx: 0 };
      return false;
    }
    const now = this.clock;
    const stillness = now - a.lastMove;
    const bored = now - a.since > a.patience && a.dist > 150;
    if (!this.followMouse || !this.attentive || a.dist > 700 || stillness > 3 || bored) {
      a.interested = false;
      a.boredUntil = now + rand([3, 9]);
      this.lookLean = { rz: 0, rx: 0 };
      if (bored) this.glance(-Math.sign(a.dx || 1) * 0.7, rand([-0.3, 0.2]), 0.8); // looks away, a bit aloof
      return false;
    }
    const c = this.gazeCentre;
    this.face.gazeX = clampAbs(c.x * 0.4 + a.dx / 260, 1);
    this.face.gazeY = clampAbs(c.y * 0.4 + (a.dy / 260) * 0.8, 1);
    const near = 1 - Math.min(1, a.dist / 420);
    this.lookLean = { rz: clampAbs(-a.dx / 300, 1) * 0.035, rx: near * 0.06 * (a.dy > 0 ? 1 : -0.5) };
    return true;
  }

  private applyState(state: RobotStateName, withClip = true): void {
    const def = STATES[state];
    this.state = state;
    if (state === "excited") this.onMoment("excited");
    this.indicator = def.indicator ?? "none";
    this.face.setExpression(this.expressionFor(state));
    this.flashUntil = -1;
    this.stateEnds = def.duration ? this.clock + def.duration : Infinity;
    this.nextRepeat = def.repeat ? this.clock + def.repeat[1] : Infinity;
    if (withClip && def.enter) {
      const clip = Array.isArray(def.enter) ? def.enter[Math.floor(Math.random() * def.enter.length)] : def.enter;
      this.clips.play(clip, variation());
      if (state === "excited") this.stateEnds = this.clock + Math.max(def.duration ?? 0, clip === "dance" ? 2.8 : 1.9);
    }
    if (def.saccade === null) {
      this.face.gazeX = this.gazeCentre.x;
      this.face.gazeY = this.gazeCentre.y;
    }
  }

  private updateBlink(def: StateDef): void {
    if (!this.blinks.length && this.clock >= this.nextBlink) {
      this.blinkNow(Math.random() < 0.2);
      this.nextBlink = this.clock + rand(def.blink);
    }
    // close 70 ms, hold 40 ms, open 110 ms
    let v = 0;
    for (const start of this.blinks) {
      const t = this.clock - start;
      if (t >= 0 && t < BLINK_LEN) v = Math.max(v, t < 0.07 ? t / 0.07 : t < 0.11 ? 1 : 1 - (t - 0.11) / 0.11);
    }
    this.blinks = this.blinks.filter((start) => this.clock - start < BLINK_LEN);
    this.face.face.blink = v;
  }

  private updateGaze(def: StateDef): void {
    if (this.gazeQueue.length && this.clock >= this.gazeQueue[0].at) {
      const g = this.gazeQueue.shift()!;
      this.face.gazeX = g.x;
      this.face.gazeY = g.y;
    }
    if (def.saccade && !this.gazeQueue.length && this.clock >= this.nextSaccade) {
      const far = Math.random() < 0.3;
      const range = this.state === "thinking" || this.state === "peeking" ? 0.25 : far ? 0.85 : 0.35;
      const c = this.gazeCentre;
      this.face.gazeX = c.x + (Math.random() * 2 - 1) * range;
      this.face.gazeY = c.y + (Math.random() * 2 - 1) * range * 0.6;
      // Glances away come back to centre; small darts just stay.
      if (far) this.gazeQueue = [{ at: this.clock + rand([0.6, 1.4]), ...c }];
      this.nextSaccade = this.clock + rand(def.saccade);
    }
  }

  private updateBehaviours(): void {
    if (this.walking || this.clock < this.nextBehaviour || this.clips.active || this.flashUntil > this.clock) return;
    const energy = energyNow();
    const style = ACTIVITY[this.focus ? "coding" : this.activity];
    const feel = MOOD_STYLE[this.mood];
    // (while you're coding or watching, being bored doesn't make it pester you)
    const bored = this.activity === "none" ? feel.bored : 0;
    const weightOf = (b: Behaviour) =>
      b.weight *
      (b.mood === "lively" ? energy.lively * style.lively * feel.lively
        : b.mood === "tired" ? energy.tired * style.tired * feel.tired
        : b.mood === "bored" ? bored
        : style.calm * feel.calm) *
      (style.boost?.[b.name] ?? 1);
    const options = BEHAVIOURS.filter((b) => b.name !== this.lastBehaviour && (this.cooldowns.get(b.name) ?? 0) <= this.clock);
    const total = options.reduce((s, b) => s + weightOf(b), 0);
    let pick = Math.random() * total;
    for (const b of options) {
      pick -= weightOf(b);
      if (pick <= 0) {
        b.run(this);
        this.lastBehaviour = b.name;
        this.cooldowns.set(b.name, this.clock + b.cooldown * rand([0.8, 1.3]) * (style.cooldown ?? 1));
        break;
      }
    }
    // Livelier = shorter pauses between things.
    this.nextBehaviour = this.clock + (rand([5, 13]) / Math.max(0.7, Math.min(1.3, energy.lively))) * style.pause * feel.pause;
  }

  private updatePose(dt: number, def: StateDef): void {
    const k = 1 - Math.exp(-dt * 3);
    this.wobble += (def.wobble - this.wobble) * k;
    const t = this.clock;
    const w = this.wobble;
    const breathe = this.state === "sleepy" ? 0.25 : 0.27;

    // Incommensurate sines = organic, never-quite-repeating sway.
    const sway = (Math.sin(t * 0.83) * 0.6 + Math.sin(t * 1.37 + 1.1) * 0.4) * 0.022 * w;
    const rock = (Math.sin(t * 0.61 + 0.4) * 0.6 + Math.sin(t * 1.13) * 0.4) * 0.016 * w;
    const breath = Math.sin(t * Math.PI * 2 * breathe) * 0.011 * (0.5 + w * 0.5);

    // The body turns a little towards where the eyes look.
    this.headYaw += (this.face.face.lookX * 0.16 - this.headYaw) * (1 - Math.exp(-dt * 4));

    // Swing while being carried.
    const swingTarget = this.dragging ? clampAbs(-this.dragVelocity * 0.00035, 0.35) : 0;
    this.swing += (swingTarget - this.swing) * (1 - Math.exp(-dt * 6));

    const lk = 1 - Math.exp(-dt * 4);
    this.lean.ry += (this.leanTarget.ry - this.lean.ry) * lk;
    this.lean.rz += (this.leanTarget.rz - this.lean.rz) * lk;

    const c = this.clips.pose;

    // Landing detection: falling fast, then on the ground -> squash and wobble.
    const vy = (c.py - this.prevPy) / Math.max(dt, 1e-3);
    if (this.prevPy > 0.05 && c.py < 0.015 && this.prevVy < -0.4) {
      const s = Math.min(1, -this.prevVy / 3);
      this.kick("sy", -1.7 * s);
      this.kick("rz", (Math.random() - 0.5) * 1.6 * s);
    }
    this.prevPy = c.py;
    this.prevVy = vy;

    // Springs (semi-implicit Euler, underdamped: a couple of soft wobbles).
    for (const [name, s] of Object.entries(this.jig) as ["rz" | "rx" | "sy", Spring][]) {
      const stiffness = name === "sy" ? 220 : 130;
      s.v += (-stiffness * s.x - 7 * s.v) * dt;
      s.x += s.v * dt;
      if (Math.abs(s.x) < 1e-4 && Math.abs(s.v) < 1e-3) s.x = s.v = 0;
    }

    // Leaning towards the pointer, eased.
    const ll = 1 - Math.exp(-dt * 3);
    this.lookLeanNow.rz += (this.lookLean.rz - this.lookLeanNow.rz) * ll;
    this.lookLeanNow.rx += (this.lookLean.rx - this.lookLeanNow.rx) * ll;

    // Grooving to a song: a bouncy bob on the beat (~110 bpm) and a side-to-side sway every two beats.
    const grooving = this.music && (this.state === "idle" || this.state === "happy" || this.state === "speaking");
    const grooveTarget = grooving ? (this.activity === "music" ? 1 : 0.35) : 0;
    this.groove += (grooveTarget - this.groove) * (1 - Math.exp(-dt * 2));
    // In time with the real beat when we can hear one (dip on the beat), else ~110 bpm.
    const live = this.beat && this.clock - this.beat.heard < 8;
    // (phase -90° at a beat: sin = -1, the squashed bottom of the bob)
    const beat = live ? ((t - this.beat!.t0) / this.beat!.period) * Math.PI * 2 - Math.PI / 2 : t * Math.PI * 2 * 1.85;
    this.beatPhase = beat;
    const g = this.groove;

    const squash = clampAbs(this.jig.sy.x, 0.2);
    this.pose = {
      px: c.px + Math.sin(beat / 2) * 0.012 * g,
      py: c.py + Math.max(0, breath) * 0.2 + Math.max(0, Math.sin(beat)) * 0.028 * g,
      rx: c.rx + rock + this.face.face.lookY * 0.05 + this.jig.rx.x + this.lookLeanNow.rx,
      ry: c.ry + this.headYaw + this.lean.ry + Math.sin(beat / 2) * 0.08 * g,
      rz: c.rz + sway + this.swing + this.lean.rz + this.jig.rz.x + this.lookLeanNow.rz + Math.sin(beat / 2) * 0.06 * g,
      sx: c.sx * (1 - breath * 0.4) * (1 - squash * 0.6),
      sy: c.sy * (1 + breath) * (1 + squash) * (1 - Math.max(0, -Math.sin(beat)) * 0.035 * g),
    };
  }
}

function rand([lo, hi]: [number, number]): number {
  return lo + Math.random() * (hi - lo);
}

function sign(): 1 | -1 {
  return Math.random() < 0.5 ? -1 : 1;
}

function clampAbs(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v));
}
