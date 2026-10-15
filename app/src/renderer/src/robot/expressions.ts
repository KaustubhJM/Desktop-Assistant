// expressions.ts — eye presets, and the animator that eases the live face
// towards a preset. Gaze (look) and blinks are layered on top separately so
// they keep working whatever the expression.

import type { ExpressionName } from "../../../shared/types";
import type { EyeShape, Face } from "./eyes";

const EYE: EyeShape = { w: 12, h: 15.5, r: 0.3, lid: 0, low: 0, slant: 0, smile: 0, dx: 0, dy: 0, scale: 1 };
const SPACING = 23;

interface Preset {
  left: Partial<EyeShape>;
  right: Partial<EyeShape>;
  spacing?: number;
  brightness?: number;
  /** Gaze bias added to wherever the eyes are looking. */
  lookX?: number;
  lookY?: number;
}

const both = (e: Partial<EyeShape>, extra: Omit<Preset, "left" | "right"> = {}): Preset => ({ left: e, right: e, ...extra });

export const PRESETS: Record<ExpressionName, Preset> = {
  neutral: both({}),
  happy: both({ smile: 1, w: 13, dy: -1 }, { brightness: 1.1 }),
  excited: both({ smile: 0.85, scale: 1.08, w: 13, dy: -1 }, { brightness: 1.2 }),
  content: both({ smile: 0.55, lid: 0.3, dy: 0.5 }, { brightness: 0.95 }),
  curious: {
    left: { scale: 1.12, r: 0.36 },
    right: { scale: 0.9, lid: 0.24, slant: -0.25 },
    lookX: 0.5,
    lookY: -0.2,
  },
  sleepy: both({ lid: 0.58, slant: -0.4, h: 14, dy: 1 }, { brightness: 0.7, lookY: 0.35 }),
  surprised: both({ w: 13.5, h: 18, r: 0.44, scale: 1.06 }, { brightness: 1.15 }),
  focused: both({ lid: 0.16, slant: 0.6, low: 0.12, h: 14 }, { brightness: 1.05 }),
  listening: both({ w: 12.5, h: 16.5, r: 0.38 }, { brightness: 1.05, lookY: -0.05 }),
  thinking: {
    left: { lid: 0.26, slant: -0.2 },
    right: { lid: 0.08 },
    lookX: -0.55,
    lookY: -0.6,
  },
  alert: both({ w: 13, h: 17.5, r: 0.36, slant: -0.1 }, { brightness: 1.25 }),
  squint: both({ lid: 0.42, low: 0.26, slant: 0.1 }, { brightness: 1.05 }),
  wink: {
    left: { smile: 0.35, dy: -0.5 },
    right: { lid: 0.94, slant: -0.3, dy: 0.5 },
    brightness: 1.1,
  },
};

export interface Target {
  left: EyeShape;
  right: EyeShape;
  spacing: number;
  brightness: number;
  lookBiasX: number;
  lookBiasY: number;
}

export function presetTarget(name: ExpressionName): Target {
  const p = PRESETS[name];
  return {
    left: { ...EYE, ...p.left },
    right: { ...EYE, ...p.right },
    spacing: p.spacing ?? SPACING,
    brightness: p.brightness ?? 1,
    lookBiasX: p.lookX ?? 0,
    lookBiasY: p.lookY ?? 0,
  };
}

const EYE_KEYS = Object.keys(EYE) as (keyof EyeShape)[];

/** Eases the live face towards targets; reports whether anything visibly moved. */
export class FaceAnimator {
  readonly face: Face = {
    left: { ...EYE },
    right: { ...EYE },
    spacing: SPACING,
    lookX: 0,
    lookY: 0,
    brightness: 1,
    blink: 0,
    pupil: 0,
  };
  private target: Target = presetTarget("neutral");
  expression: ExpressionName = "neutral";
  /** Where the eyes are looking (set by saccades / behaviours), before bias. */
  gazeX = 0;
  gazeY = 0;
  /** Extra multipliers applied per frame (speaking pulse, etc.). */
  heightPulse = 0;
  brightnessPulse = 0;
  pupilTarget = 0;
  private lastSignature = "";

  setExpression(name: ExpressionName): void {
    this.expression = name;
    this.target = presetTarget(name);
  }

  /** Jump straight to the target (used when freezing for captures). */
  snap(): void {
    this.step(10);
  }

  /** Advance easing by dt seconds. Returns true if the drawn face changed. */
  step(dt: number): boolean {
    const shapeK = 1 - Math.exp(-dt * 13);
    const gazeK = 1 - Math.exp(-dt * 26);
    const f = this.face;
    for (const side of ["left", "right"] as const) {
      for (const k of EYE_KEYS) {
        f[side][k] += (this.target[side][k] - f[side][k]) * shapeK;
      }
    }
    f.spacing += (this.target.spacing - f.spacing) * shapeK;
    f.brightness += (this.target.brightness + this.brightnessPulse - f.brightness) * shapeK;
    f.pupil += (this.pupilTarget - f.pupil) * shapeK;
    const lx = clamp(this.gazeX + this.target.lookBiasX, -1, 1);
    const ly = clamp(this.gazeY + this.target.lookBiasY, -1, 1);
    f.lookX += (lx - f.lookX) * gazeK;
    f.lookY += (ly - f.lookY) * gazeK;

    // Speaking/listening pulse squeezes the eyes slightly.
    const hp = 1 + this.heightPulse;
    const drawn = this.signature(hp);
    const changed = drawn !== this.lastSignature;
    this.lastSignature = drawn;
    return changed;
  }

  /** The face to draw this frame (with per-frame pulses applied). */
  drawable(): Face {
    const hp = 1 + this.heightPulse;
    if (hp === 1) return this.face;
    return {
      ...this.face,
      left: { ...this.face.left, h: this.face.left.h * hp },
      right: { ...this.face.right, h: this.face.right.h * hp },
    };
  }

  /** Quantised fingerprint of what would be drawn, to skip redundant redraws. */
  private signature(hp: number): string {
    const f = this.face;
    const q = (v: number) => Math.round(v * 40);
    const eye = (e: EyeShape) => EYE_KEYS.map((k) => q(e[k])).join(",");
    return [eye(f.left), eye(f.right), q(f.spacing), q(f.lookX), q(f.lookY), q(f.brightness), q(f.blink), q(f.pupil), q(hp)].join("|");
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
