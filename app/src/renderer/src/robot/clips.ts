// clips.ts — keyframed body animation clips (bounce, hop, spin, backflip...)
// and a player that crossfades between them.
//
// Channels: px/py = lift (robot heights), rx/ry/rz = rotation about the body
// centre (radians), sx/sy = squash and stretch about the feet. Every clip
// starts and ends at rest, so it hands back cleanly to the idle motion.

import type { ClipName, ClipOptions } from "../../../shared/types";

export type Channel = "px" | "py" | "rx" | "ry" | "rz" | "sx" | "sy";
type Ease = "linear" | "in" | "out" | "inOut" | "backOut";
type Key = [t: number, v: number, ease?: Ease];

export interface Clip {
  duration: number;
  tracks: Partial<Record<Channel, Key[]>>;
  /** Channels that turn a full circle (spin, flip): never scaled by amp. */
  fullTurn?: Channel[];
}

export type Pose = Record<Channel, number>;
export const REST: Pose = { px: 0, py: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1 };

const TAU = Math.PI * 2;

export const CLIP_DEFS: Record<ClipName, Clip> = {
  bounce: {
    duration: 0.75,
    tracks: {
      sy: [[0, 1], [0.12, 0.9, "out"], [0.3, 1.07, "out"], [0.48, 0.94, "in"], [0.6, 1.02], [0.75, 1]],
      sx: [[0, 1], [0.12, 1.07, "out"], [0.3, 0.96, "out"], [0.48, 1.05, "in"], [0.6, 0.99], [0.75, 1]],
      py: [[0, 0], [0.12, 0], [0.3, 0.2, "out"], [0.48, 0, "in"], [0.75, 0]],
    },
  },
  hop: {
    duration: 0.95,
    tracks: {
      sy: [[0, 1], [0.16, 0.86, "out"], [0.3, 1.1, "out"], [0.52, 1], [0.66, 0.88, "in"], [0.8, 1.03], [0.95, 1]],
      sx: [[0, 1], [0.16, 1.1, "out"], [0.3, 0.94, "out"], [0.52, 1], [0.66, 1.09, "in"], [0.8, 0.99], [0.95, 1]],
      py: [[0, 0], [0.16, 0], [0.42, 0.42, "out"], [0.66, 0, "in"], [0.95, 0]],
      rx: [[0, 0], [0.16, 0.06], [0.42, -0.05], [0.66, 0.04], [0.95, 0]],
    },
  },
  jump: {
    duration: 1.25,
    tracks: {
      sy: [[0, 1], [0.22, 0.82, "out"], [0.36, 1.14, "out"], [0.6, 1], [0.85, 0.85, "in"], [1.02, 1.04], [1.25, 1]],
      sx: [[0, 1], [0.22, 1.12, "out"], [0.36, 0.92, "out"], [0.6, 1], [0.85, 1.12, "in"], [1.02, 0.98], [1.25, 1]],
      py: [[0, 0], [0.22, 0], [0.55, 0.9, "out"], [0.85, 0, "in"], [1.25, 0]],
      rz: [[0, 0], [0.4, 0.05], [0.7, -0.04], [0.85, 0], [1.25, 0]],
    },
  },
  tilt: {
    duration: 1.6,
    tracks: {
      rz: [[0, 0], [0.35, 0.24, "out"], [1.15, 0.21], [1.6, 0, "inOut"]],
      ry: [[0, 0], [0.35, 0.18, "out"], [1.15, 0.15], [1.6, 0, "inOut"]],
      py: [[0, 0], [0.18, 0.03, "out"], [0.4, 0, "in"], [1.6, 0]],
    },
  },
  spin: {
    duration: 1.4,
    fullTurn: ["ry"],
    tracks: {
      ry: [[0, 0], [0.18, -0.25, "out"], [1.05, TAU, "inOut"], [1.4, TAU]],
      py: [[0, 0], [0.25, 0], [0.6, 0.22, "out"], [0.95, 0, "in"], [1.4, 0]],
      sy: [[0, 1], [0.18, 0.9], [0.32, 1.06], [0.95, 0.92, "in"], [1.1, 1.02], [1.4, 1]],
      sx: [[0, 1], [0.18, 1.07], [0.32, 0.96], [0.95, 1.06, "in"], [1.1, 0.99], [1.4, 1]],
    },
  },
  backflip: {
    duration: 1.6,
    fullTurn: ["rx"],
    tracks: {
      sy: [[0, 1], [0.22, 0.8, "out"], [0.36, 1.12, "out"], [0.55, 1], [1.12, 1], [1.24, 0.84, "in"], [1.42, 1.04], [1.6, 1]],
      sx: [[0, 1], [0.22, 1.13, "out"], [0.36, 0.93, "out"], [0.55, 1], [1.12, 1], [1.24, 1.12, "in"], [1.42, 0.98], [1.6, 1]],
      py: [[0, 0], [0.22, 0], [0.68, 1.05, "out"], [1.24, 0, "in"], [1.6, 0]],
      rx: [[0, 0], [0.3, 0], [1.14, -TAU, "inOut"], [1.6, -TAU]],
    },
  },
  startle: {
    duration: 0.65,
    tracks: {
      py: [[0, 0], [0.07, 0.1, "out"], [0.3, 0, "in"], [0.65, 0]],
      sy: [[0, 1], [0.07, 1.1, "out"], [0.25, 0.95], [0.4, 1.02], [0.65, 1]],
      sx: [[0, 1], [0.07, 0.93, "out"], [0.25, 1.04], [0.4, 0.99], [0.65, 1]],
      rz: [[0, 0], [0.1, 0.05], [0.2, -0.05], [0.3, 0.03], [0.4, -0.015], [0.65, 0]],
    },
  },
  wobble: {
    duration: 1.3,
    tracks: {
      rz: [[0, 0], [0.15, 0.13], [0.38, -0.11], [0.6, 0.08], [0.82, -0.05], [1.02, 0.025], [1.3, 0]],
    },
  },
  nod: {
    duration: 0.9,
    tracks: {
      rx: [[0, 0], [0.18, 0.16, "out"], [0.38, -0.02], [0.55, 0.1], [0.72, 0], [0.9, 0]],
    },
  },
  stretch: {
    duration: 2.0,
    tracks: {
      sy: [[0, 1], [0.6, 1.13, "inOut"], [1.2, 1.13], [1.45, 0.94, "in"], [1.65, 1.03], [2, 1]],
      sx: [[0, 1], [0.6, 0.93, "inOut"], [1.2, 0.93], [1.45, 1.05, "in"], [1.65, 0.99], [2, 1]],
      rz: [[0, 0], [0.7, 0.05], [1.0, -0.05], [1.2, 0], [2, 0]],
    },
  },
  shake: {
    duration: 0.8,
    tracks: {
      ry: [[0, 0], [0.1, 0.26], [0.25, -0.24], [0.4, 0.17], [0.55, -0.1], [0.8, 0]],
    },
  },
  land: {
    duration: 0.5,
    tracks: {
      sy: [[0, 1], [0.08, 0.86, "out"], [0.25, 1.04], [0.5, 1]],
      sx: [[0, 1], [0.08, 1.1, "out"], [0.25, 0.98], [0.5, 1]],
    },
  },
  lookback: {
    duration: 1.7,
    tracks: {
      ry: [[0, 0], [0.4, 0.6, "out"], [1.15, 0.52], [1.7, 0, "inOut"]],
      rz: [[0, 0], [0.4, -0.05], [1.15, -0.03], [1.7, 0]],
      rx: [[0, 0], [0.4, -0.04], [1.7, 0]],
    },
  },
  shiver: {
    duration: 0.8,
    tracks: {
      rz: oscillate(0.8, 0.035, 14, 0.12),
      sx: [[0, 1], [0.1, 0.97], [0.65, 0.97], [0.8, 1]],
      sy: [[0, 1], [0.1, 1.03], [0.65, 1.03], [0.8, 1]],
    },
  },
  dance: {
    duration: 2.6,
    tracks: {
      py: beats(2.6, 4, 0.09),
      rz: [[0, 0], [0.33, 0.13], [0.65, 0], [0.98, -0.13], [1.3, 0], [1.63, 0.13], [1.95, 0], [2.28, -0.13], [2.6, 0]],
      ry: [[0, 0], [0.65, 0.18], [1.3, -0.18], [1.95, 0.18], [2.6, 0]],
      sy: squashOnBeats(2.6, 4),
    },
  },
  doublehop: {
    duration: 1.35,
    tracks: {
      py: [[0, 0], [0.1, 0], [0.3, 0.26, "out"], [0.5, 0, "in"], [0.62, 0], [0.84, 0.32, "out"], [1.06, 0, "in"], [1.35, 0]],
      sy: [[0, 1], [0.1, 0.88, "out"], [0.22, 1.08], [0.5, 0.9, "in"], [0.6, 1.06], [1.06, 0.88, "in"], [1.2, 1.03], [1.35, 1]],
      sx: [[0, 1], [0.1, 1.08, "out"], [0.22, 0.95], [0.5, 1.07, "in"], [0.6, 0.96], [1.06, 1.08, "in"], [1.2, 0.99], [1.35, 1]],
      rz: [[0, 0], [0.3, 0.06], [0.84, -0.06], [1.35, 0]],
    },
  },
  bow: {
    duration: 1.7,
    tracks: {
      rx: [[0, 0], [0.45, 0.4, "out"], [1.0, 0.4], [1.4, -0.05, "inOut"], [1.7, 0]],
      py: [[0, 0], [0.45, 0.02], [1.0, 0.02], [1.4, 0]],
    },
  },
  dizzy: {
    duration: 2.2,
    tracks: {
      rz: decayingWave(2.2, 0.14, 2.2, 0),
      rx: decayingWave(2.2, 0.09, 2.2, Math.PI / 2),
      py: [[0, 0], [0.2, 0.02], [2.2, 0]],
    },
  },
  sneeze: {
    duration: 1.35,
    tracks: {
      rx: [[0, 0], [0.5, -0.12, "inOut"], [0.62, -0.17], [0.7, 0.22, "out"], [0.98, -0.04], [1.35, 0]],
      sy: [[0, 1], [0.5, 1.06, "inOut"], [0.62, 1.07], [0.7, 0.86, "out"], [0.9, 1.04], [1.35, 1]],
      sx: [[0, 1], [0.5, 0.96], [0.7, 1.1, "out"], [0.9, 0.98], [1.35, 1]],
      py: [[0, 0], [0.7, 0], [0.76, 0.05, "out"], [0.95, 0, "in"], [1.35, 0]],
    },
  },
  peer: {
    duration: 1.9,
    tracks: {
      rx: [[0, 0], [0.45, 0.15, "out"], [1.35, 0.15], [1.9, 0, "inOut"]],
      py: [[0, 0], [0.45, 0.035, "out"], [1.35, 0.035], [1.9, 0]],
      ry: [[0, 0], [0.45, 0.08], [0.9, -0.06], [1.35, 0.05], [1.9, 0]],
    },
  },
  yawn: {
    duration: 2.6,
    tracks: {
      sy: [[0, 1], [1.0, 1.09, "inOut"], [1.7, 1.09], [2.1, 0.96, "in"], [2.6, 1]],
      sx: [[0, 1], [1.0, 0.95, "inOut"], [1.7, 0.95], [2.1, 1.03, "in"], [2.6, 1]],
      rx: [[0, 0], [1.0, -0.13, "inOut"], [1.7, -0.13], [2.1, 0.04], [2.6, 0]],
      rz: [[0, 0], [1.2, 0.04], [1.7, -0.03], [2.6, 0]],
    },
  },
  wiggle: {
    duration: 1.0,
    tracks: {
      sx: [[0, 1], [0.12, 1.08], [0.24, 0.94], [0.36, 1.07], [0.48, 0.95], [0.62, 1.03], [0.8, 0.99], [1, 1]],
      sy: [[0, 1], [0.12, 0.93], [0.24, 1.06], [0.36, 0.94], [0.48, 1.05], [0.62, 0.98], [0.8, 1.01], [1, 1]],
      rz: [[0, 0], [0.24, 0.04], [0.48, -0.04], [0.8, 0], [1, 0]],
    },
  },
  // One little step while wandering (played over and over; mirror = direction).
  walk: {
    duration: 0.44,
    tracks: {
      py: [[0, 0], [0.11, 0.07, "out"], [0.22, 0, "in"], [0.33, 0.07, "out"], [0.44, 0, "in"]],
      rz: [[0, 0], [0.11, 0.08], [0.22, 0], [0.33, -0.08], [0.44, 0]],
      sy: [[0, 1], [0.05, 1.03], [0.2, 0.96], [0.27, 1.03], [0.42, 0.96], [0.44, 1]],
      sx: [[0, 1], [0.05, 0.98], [0.2, 1.03], [0.27, 0.98], [0.42, 1.03], [0.44, 1]],
    },
  },
  shrug: {
    duration: 1.1,
    tracks: {
      py: [[0, 0], [0.25, 0.07, "out"], [0.6, 0.07], [0.85, 0, "in"], [1.1, 0]],
      sx: [[0, 1], [0.25, 0.95], [0.6, 0.95], [0.85, 1.04], [1.1, 1]],
      sy: [[0, 1], [0.25, 1.05], [0.6, 1.05], [0.85, 0.95], [1.1, 1]],
      rz: [[0, 0], [0.25, 0.05], [0.6, -0.05], [0.85, 0], [1.1, 0]],
    },
  },
};

// ------------------------------------------------- generated keyframe helpers

/** Fast alternating jitter (shiver), fading in and out at the edges. */
function oscillate(duration: number, amp: number, hz: number, edge: number): Key[] {
  const keys: Key[] = [];
  const steps = Math.round(duration * hz * 2);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration;
    const env = Math.min(1, t / edge, (duration - t) / edge);
    keys.push([t, (i % 2 ? 1 : -1) * amp * Math.max(0, env), "linear"]);
  }
  keys[keys.length - 1] = [duration, 0];
  return keys;
}

/** Little bounces on a beat (dance). */
function beats(duration: number, count: number, height: number): Key[] {
  const keys: Key[] = [[0, 0]];
  const beat = duration / count;
  for (let i = 0; i < count; i++) {
    keys.push([i * beat + beat * 0.45, height, "out"], [i * beat + beat, 0, "in"]);
  }
  return keys;
}

function squashOnBeats(duration: number, count: number): Key[] {
  const keys: Key[] = [[0, 1]];
  const beat = duration / count;
  for (let i = 0; i < count; i++) {
    keys.push([i * beat + beat * 0.45, 1.04], [i * beat + beat * 0.98, 0.93, "in"]);
  }
  keys.push([duration, 1]);
  return keys;
}

/** A circling sway that dies down (dizzy). */
function decayingWave(duration: number, amp: number, hz: number, phase: number): Key[] {
  const keys: Key[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration;
    const env = 1 - t / duration;
    keys.push([t, Math.sin(t * Math.PI * 2 * hz * 0.5 + phase) * amp * env * env, "linear"]);
  }
  keys[keys.length - 1] = [duration, 0];
  return keys;
}

const EASES: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - (1 - u) ** 3,
  inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
  backOut: (u) => 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2,
};

export function sampleClip(clip: Clip, t: number): Pose {
  const pose = { ...REST };
  for (const [ch, keys] of Object.entries(clip.tracks) as [Channel, Key[]][]) {
    pose[ch] = sampleKeys(keys, t);
  }
  return pose;
}

function sampleKeys(keys: Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, ease] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const u = (t - t0) / (t1 - t0 || 1);
      return v0 + (v1 - v0) * EASES[ease ?? "inOut"](u);
    }
  }
  return keys[keys.length - 1][1];
}

const CROSSFADE = 0.15;

/** Per-play variation: bigger/smaller motion, mirrored left/right. */
function vary(pose: Pose, clip: Clip, o: Required<ClipOptions>): Pose {
  const full = clip.fullTurn ?? [];
  const amp = (ch: Channel) => (full.includes(ch) ? 1 : o.amp);
  return {
    px: pose.px * o.amp * o.mirror,
    py: pose.py * o.amp,
    rx: pose.rx * amp("rx"),
    ry: pose.ry * amp("ry") * o.mirror,
    rz: pose.rz * amp("rz") * o.mirror,
    sx: 1 + (pose.sx - 1) * o.amp,
    sy: 1 + (pose.sy - 1) * o.amp,
  };
}

/** Plays one clip at a time; a new clip crossfades from wherever the body is. */
export class ClipPlayer {
  private clip: Clip | null = null;
  name: ClipName | null = null;
  private t = 0;
  private from: Pose = { ...REST };
  private fade = 1;
  pose: Pose = { ...REST };
  private onDone: (() => void) | null = null;
  private opts: Required<ClipOptions> = { speed: 1, amp: 1, mirror: 1 };

  get active(): boolean {
    return this.clip !== null;
  }

  play(name: ClipName, opts: ClipOptions = {}, onDone?: () => void): void {
    this.from = { ...this.pose };
    this.fade = 0;
    this.clip = CLIP_DEFS[name];
    this.name = name;
    this.t = 0;
    this.opts = { speed: opts.speed ?? 1, amp: opts.amp ?? 1, mirror: opts.mirror ?? 1 };
    this.onDone = onDone ?? null;
  }

  /** Hold a clip at a given time (self-test captures). */
  seek(name: ClipName, t: number): void {
    this.clip = CLIP_DEFS[name];
    this.name = name;
    this.t = t;
    this.fade = 1;
    this.opts = { speed: 1, amp: 1, mirror: 1 };
    this.pose = sampleClip(this.clip, t);
  }

  stop(): void {
    this.clip = null;
    this.name = null;
    this.pose = { ...REST };
  }

  update(dt: number): void {
    if (!this.clip) {
      this.pose = { ...REST };
      return;
    }
    this.t += dt * this.opts.speed;
    this.fade = Math.min(1, this.fade + dt / CROSSFADE);
    const target = vary(sampleClip(this.clip, this.t), this.clip, this.opts);
    const k = this.fade;
    const next = { ...REST };
    for (const ch of Object.keys(REST) as Channel[]) {
      next[ch] = this.from[ch] + (target[ch] - this.from[ch]) * k;
    }
    this.pose = next;
    if (this.t >= this.clip.duration) {
      const done = this.onDone;
      this.clip = null;
      this.name = null;
      this.pose = { ...REST };
      done?.();
    }
  }
}
