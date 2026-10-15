// eyes.ts — the robot's display: a small LED-style pixel grid with two
// glowing eyes, drawn on a canvas that becomes the screen's texture.
//
// Each eye is a handful of numbers (see EyeShape), so every expression is a
// set of numbers and changing expression is just easing between them.
// Pipeline per frame: draw the shapes at grid resolution (antialiased, so
// edge cells get partial brightness) -> light one LED cell per grid pixel ->
// add a soft glow underneath. The glow is drawn into the texture itself
// (post-processing bloom would break the transparent window).

export const GRID_W = 48;
export const GRID_H = 36;
const CELL = 8;
export const DISPLAY_W = GRID_W * CELL;
export const DISPLAY_H = GRID_H * CELL;

/** Maximum eye travel for lookX/lookY = ±1, in grid cells. */
const LOOK_X = 5.5;
const LOOK_Y = 3.2;

export interface EyeShape {
  w: number; // width, cells
  h: number; // height, cells
  r: number; // corner roundness, fraction of min(w, h)
  lid: number; // top lid closure 0..1
  low: number; // bottom lid closure 0..1 (flat, for squints)
  slant: number; // -1..1, + lowers inner corners (determined), - lowers outer (sleepy/soft)
  smile: number; // 0..1, carves a "^" arch from below (happy)
  dx: number; // extra offset, cells
  dy: number;
  scale: number;
}

export type Indicator = "none" | "listening" | "thinking" | "working" | "speaking" | "notify" | "zzz";

export interface Face {
  left: EyeShape;
  right: EyeShape;
  spacing: number; // distance between eye centres, cells
  lookX: number; // -1..1
  lookY: number; // -1..1 (+ = down)
  brightness: number;
  blink: number; // 0..1 overlay on both lids
  pupil: number; // 0..1, dark pupil cut into each eye (purple theme)
}

export interface IndicatorState {
  kind: Indicator;
  phase: number; // seconds, drives indicator animation
  level: number; // 0..1, audio-ish level for listening/speaking
}

export class EyeDisplay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly lo: HTMLCanvasElement;
  private readonly loCtx: CanvasRenderingContext2D;
  private readonly tint: HTMLCanvasElement;
  private readonly tintCtx: CanvasRenderingContext2D;
  private readonly backdrop: HTMLCanvasElement;
  private color = "#3be3ff";
  private rgb: [number, number, number] = [59, 227, 255];

  constructor() {
    this.canvas = makeCanvas(DISPLAY_W, DISPLAY_H);
    this.ctx = this.canvas.getContext("2d")!;
    this.lo = makeCanvas(GRID_W, GRID_H);
    this.loCtx = this.lo.getContext("2d", { willReadFrequently: true })!;
    this.tint = makeCanvas(GRID_W, GRID_H);
    this.tintCtx = this.tint.getContext("2d")!;
    this.backdrop = makeCanvas(DISPLAY_W, DISPLAY_H);
    this.drawBackdrop();
  }

  setColor(hex: string): void {
    this.color = hex;
    this.rgb = hexToRgb(hex);
  }

  draw(face: Face, indicator: IndicatorState): void {
    const lo = this.loCtx;
    lo.clearRect(0, 0, GRID_W, GRID_H);
    lo.fillStyle = "#fff";

    const cy = GRID_H / 2 - 1 + face.lookY * LOOK_Y;
    const cx = GRID_W / 2 + face.lookX * LOOK_X;
    this.drawEye(lo, cx - face.spacing / 2, cy, face.left, -1, face);
    this.drawEye(lo, cx + face.spacing / 2, cy, face.right, 1, face);
    this.drawIndicator(lo, indicator);

    // Colourised copy of the grid for the glow pass.
    const t = this.tintCtx;
    t.globalCompositeOperation = "copy";
    t.drawImage(this.lo, 0, 0);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = this.color;
    t.fillRect(0, 0, GRID_W, GRID_H);

    const out = this.ctx;
    out.globalCompositeOperation = "copy";
    out.drawImage(this.backdrop, 0, 0);

    // Soft glow under the LEDs.
    out.globalCompositeOperation = "lighter";
    out.filter = "blur(11px)";
    out.globalAlpha = Math.min(1, 0.55 * face.brightness);
    out.imageSmoothingEnabled = true;
    out.drawImage(this.tint, 0, 0, DISPLAY_W, DISPLAY_H);
    out.filter = "none";
    out.globalAlpha = 1;

    // One LED per grid cell; brightness = shape coverage.
    const data = lo.getImageData(0, 0, GRID_W, GRID_H).data;
    const [r, g, b] = this.rgb;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const a = data[(y * GRID_W + x) * 4 + 3] / 255;
        if (a < 0.04) continue;
        const v = Math.min(1, a * face.brightness);
        // Hot cores: the brightest cells lean towards white, like real LEDs.
        const hot = Math.max(0, v - 0.7) * 0.9;
        out.fillStyle = `rgba(${Math.round(r + (255 - r) * hot)},${Math.round(g + (255 - g) * hot)},${Math.round(b + (255 - b) * hot)},${v})`;
        out.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    out.globalCompositeOperation = "source-over";
  }

  private drawEye(ctx: CanvasRenderingContext2D, cx: number, cy: number, e: EyeShape, side: -1 | 1, face: Face): void {
    const w = e.w * e.scale;
    const h = e.h * e.scale;
    const x0 = cx + e.dx - w / 2;
    const y0 = cy + e.dy - h / 2;
    if (w <= 0.5 || h <= 0.5) return;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, Math.min(w, h) * e.r);
    ctx.fill();

    ctx.globalCompositeOperation = "destination-out";
    const lid = e.lid + (1 - e.lid) * face.blink;

    // Top lid: a straight edge, tilted by slant (inner corner = towards the nose).
    if (lid > 0.001 || Math.abs(e.slant) > 0.001) {
      const base = y0 + lid * h;
      const s = e.slant * h * 0.32;
      const xl = x0 - 2;
      const xr = x0 + w + 2;
      const yl = base + side * s; // left eye (side -1): inner edge is on its right
      const yr = base - side * s;
      ctx.beginPath();
      ctx.moveTo(xl, y0 - 40);
      ctx.lineTo(xr, y0 - 40);
      ctx.lineTo(xr, yr);
      ctx.lineTo(xl, yl);
      ctx.closePath();
      ctx.fill();
    }

    // Bottom lid: flat cut from below (squints, focus).
    if (e.low > 0.001) {
      ctx.fillRect(x0 - 2, y0 + h - e.low * h, w + 4, h + 4);
    }

    // Happy arch: an ellipse carved from below leaves an upside-down "U".
    if (e.smile > 0.001) {
      ctx.beginPath();
      ctx.ellipse(cx + e.dx, y0 + h * 1.18, w * 0.74, h * 0.64 * e.smile, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pupil (purple theme): a dark square that follows the gaze.
    if (face.pupil > 0.01) {
      ctx.globalAlpha = face.pupil;
      const pw = w * 0.4;
      const ph = h * 0.36;
      const px = cx + e.dx - pw / 2 + face.lookX * w * 0.16 - w * 0.08;
      const py = y0 + h * 0.3 + face.lookY * h * 0.12;
      ctx.fillRect(px, py, pw, ph);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawIndicator(ctx: CanvasRenderingContext2D, ind: IndicatorState): void {
    const t = ind.phase;
    const mid = GRID_W / 2;
    const base = GRID_H - 5;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    switch (ind.kind) {
      case "listening":
      case "speaking": {
        // A tiny equaliser under the eyes, driven by the (audio) level.
        const bars = ind.kind === "listening" ? 3 : 5;
        for (let i = 0; i < bars; i++) {
          const k = i - (bars - 1) / 2;
          const wave = 0.5 + 0.5 * Math.sin(t * 9 + i * 1.7);
          const hgt = 1 + Math.round((0.35 + 0.65 * ind.level) * wave * 3.2);
          ctx.globalAlpha = ind.kind === "listening" ? 0.9 : 0.55;
          ctx.fillRect(mid + k * 3 - 1, base + 2 - hgt, 2, hgt);
        }
        break;
      }
      case "thinking": {
        for (let i = 0; i < 3; i++) {
          const on = Math.floor(t * 3) % 3 === i;
          ctx.globalAlpha = on ? 1 : 0.3;
          ctx.fillRect(mid - 4 + i * 3, base, 2, 2);
        }
        break;
      }
      case "working": {
        ctx.globalAlpha = 0.25;
        ctx.fillRect(mid - 8, base + 1, 16, 1);
        ctx.globalAlpha = 0.95;
        const pos = ((t * 0.6) % 1) * 20 - 2;
        ctx.fillRect(mid - 8 + Math.max(0, pos), base + 1, Math.min(4, 16 - pos, pos + 4), 1);
        break;
      }
      case "notify": {
        // The whole display edge pulses.
        ctx.globalAlpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 6));
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(1.5, 1.5, GRID_W - 3, GRID_H - 3, 4);
        ctx.stroke();
        break;
      }
      case "zzz": {
        // Little pixel "z"s drifting up and fading.
        for (let i = 0; i < 2; i++) {
          const p = (t * 0.35 + i * 0.5) % 1;
          ctx.globalAlpha = Math.sin(p * Math.PI) * 0.85;
          drawZ(ctx, GRID_W - 10 + i * 3 + p * 2, 9 - p * 6 - i * 2, i === 0 ? 3 : 2);
        }
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  /** Static dark glass with an unlit LED grid, cached once. */
  private drawBackdrop(): void {
    const ctx = this.backdrop.getContext("2d")!;
    const grad = ctx.createRadialGradient(DISPLAY_W / 2, DISPLAY_H * 0.45, 10, DISPLAY_W / 2, DISPLAY_H / 2, DISPLAY_W * 0.7);
    grad.addColorStop(0, "#0b1013");
    grad.addColorStop(1, "#040506");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    ctx.fillStyle = "rgba(120, 160, 180, 0.035)";
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      }
    }
  }
}

function drawZ(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  ctx.fillRect(px, py, size, 1);
  for (let i = 1; i < size - 1; i++) ctx.fillRect(px + size - 1 - i, py + i, 1, 1);
  ctx.fillRect(px, py + size - 1, size, 1);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
