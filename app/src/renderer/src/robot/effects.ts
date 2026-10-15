// effects.ts — little 2D flourishes around the robot, on a transparent canvas
// above the 3D one: music notes while it grooves, hearts when petted, Zzz
// when asleep, confetti when you finish a task, sparkles when excited, stars
// when dizzy, and a small badge on special days (a diya at Diwali, a cake on
// your birthday...). Nothing is drawn (or cleared) while there's nothing to show.

export type EffectKind = "note" | "heart" | "z" | "confetti" | "sparkle" | "star";

interface Particle {
  kind: EffectKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  rot: number;
  vr: number;
  color: string;
  glyph: string;
  phase: number;
}

const NOTES = ["♪", "♫", "♬"];
const CONFETTI = ["#ff6b9a", "#ffd166", "#4fe3ff", "#9b7bff", "#7ae582", "#ff9f43"];
const MAX_PARTICLES = 160;

export class Effects {
  private readonly ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private badge: { emoji: string; label: string } | null = null;
  private drewLastFrame = false;
  /** Accent colours (follow the theme). */
  colors = { a: "#4fe3ff", b: "#9b7bff" };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  get active(): number {
    return this.particles.length;
  }

  get badgeEmoji(): string | null {
    return this.badge?.emoji ?? null;
  }

  setBadge(badge: { emoji: string; label: string } | null): void {
    this.badge = badge && badge.emoji ? badge : null;
    this.canvas.title = this.badge?.label ?? "";
  }

  /** Spawn effects around a point (the robot's head, CSS px). */
  emit(kind: EffectKind, at: { x: number; y: number }, count = 1, scale = 1): void {
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const p: Particle = {
        kind, x: at.x, y: at.y, vx: 0, vy: 0, age: 0, life: 1.6, size: 16 * scale,
        rot: 0, vr: 0, color: this.colors.a, glyph: "", phase: Math.random() * Math.PI * 2,
      };
      switch (kind) {
        case "note":
          Object.assign(p, { x: at.x + side * (14 + Math.random() * 18) * scale, vx: side * 8 * scale, vy: -42 * scale, life: 1.9,
            size: (15 + Math.random() * 6) * scale, glyph: NOTES[Math.floor(Math.random() * NOTES.length)],
            color: Math.random() < 0.5 ? this.colors.a : this.colors.b, vr: side * 0.4 });
          break;
        case "heart":
          Object.assign(p, { x: at.x + (Math.random() - 0.5) * 40 * scale, y: at.y + 6 * scale, vx: (Math.random() - 0.5) * 14 * scale,
            vy: -34 * scale, life: 1.5, size: (17 + Math.random() * 7) * scale, glyph: "♥", color: "#ff6b9a" });
          break;
        case "z":
          Object.assign(p, { x: at.x + 22 * scale, vx: 14 * scale, vy: -20 * scale, life: 2.4, size: 16 * scale, glyph: "Z", color: "#bfe9ff" });
          break;
        case "confetti":
          Object.assign(p, { vx: (Math.random() - 0.5) * 260 * scale, vy: (-160 - Math.random() * 140) * scale, life: 2.1,
            size: (5 + Math.random() * 4) * scale, color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)],
            rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14 });
          break;
        case "sparkle":
          Object.assign(p, { x: at.x + (Math.random() - 0.5) * 90 * scale, y: at.y + (Math.random() - 0.3) * 70 * scale, life: 0.9,
            size: (10 + Math.random() * 8) * scale, glyph: "✦", color: Math.random() < 0.5 ? "#fff3a8" : this.colors.a });
          break;
        case "star":
          Object.assign(p, { life: 2.2, size: 11 * scale, glyph: "✦", color: "#ffe066", phase: (i / Math.max(1, count)) * Math.PI * 2 });
          break;
      }
      this.particles.push(p);
    }
  }

  /** Advance and draw. `head` is where the robot's head is now (for orbiting stars and the badge). */
  step(dt: number, head: { x: number; y: number }, scale: number, t: number): void {
    const busy = this.particles.length > 0 || this.badge !== null;
    if (!busy && !this.drewLastFrame) return;
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.drewLastFrame = busy;
    if (!busy) return;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.particles = this.particles.filter((p) => (p.age += dt) < p.life);
    for (const p of this.particles) {
      const u = p.age / p.life;
      if (p.kind === "confetti") {
        p.vy += 420 * scale * dt;
        p.vx *= 1 - 0.8 * dt;
      } else if (p.kind === "star") {
        const a = p.phase + p.age * 5;
        p.x = head.x + Math.cos(a) * 34 * scale;
        p.y = head.y - 8 * scale + Math.sin(a) * 10 * scale;
      }
      if (p.kind !== "star") {
        p.x += (p.vx + (p.kind === "note" || p.kind === "z" ? Math.sin(p.age * 4 + p.phase) * 10 * scale : 0)) * dt;
        p.y += p.vy * dt;
      }
      p.rot += p.vr * dt;
      const fade = u < 0.15 ? u / 0.15 : 1 - Math.max(0, (u - 0.6) / 0.4);
      ctx.globalAlpha = Math.max(0, Math.min(1, fade));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.kind === "confetti") {
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        const grow = p.kind === "z" ? 0.7 + u * 0.9 : p.kind === "heart" ? 0.8 + u * 0.4 : p.kind === "sparkle" ? Math.sin(u * Math.PI) : 1;
        ctx.font = `${p.kind === "z" ? "800" : "600"} ${Math.max(1, p.size * grow)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.kind === "note" || p.kind === "sparkle" || p.kind === "star" ? 6 : 0;
        ctx.fillText(p.glyph, 0, 0);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (this.badge) {
      // A small badge bobbing beside the robot's head.
      ctx.font = `${Math.round(28 * scale)}px "Segoe UI Emoji", sans-serif`;
      ctx.shadowBlur = 0;
      ctx.fillText(this.badge.emoji, head.x - 46 * scale, head.y - 6 * scale + Math.sin(t * 2) * 3 * scale);
    }
  }
}
