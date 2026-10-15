// model.ts — the robot's body, built in code (no model files): a rounded
// shell, a glossy black display carrying the eye texture, a side port, and
// a soft contact shadow.
//
// Group nesting, so each kind of motion has the right pivot:
//   root (sideways offset)
//   ├─ shadow (stays on the ground)
//   └─ lift (jumps)
//      └─ squash (scales about the feet)
//         └─ spin (rotates about the body centre)
//            └─ body, display, port

import {
  CanvasTexture,
  Color,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { ThemeName } from "../../../shared/types";

export const BODY = { w: 1.24, h: 1.0, d: 0.96, r: 0.15 };
const SCREEN = { w: 0.94, h: 0.7, r: 0.09 };

export interface Theme {
  shell: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
  eyes: string;
  pupil: number;
}

export const THEMES: Record<ThemeName, Theme> = {
  "ivory-cyan": { shell: "#efe9de", metalness: 0, roughness: 0.52, clearcoat: 0.3, eyes: "#3be3ff", pupil: 0 },
  "silver-purple": { shell: "#b8bcc2", metalness: 0.45, roughness: 0.42, clearcoat: 0.2, eyes: "#c77dff", pupil: 0.9 },
};

export interface RobotModel {
  root: Group;
  lift: Group;
  squash: Group;
  spin: Group;
  body: Mesh;
  screen: Mesh;
  shadow: Mesh;
  screenTexture: CanvasTexture;
  setTheme(theme: Theme): void;
}

export function buildRobot(displayCanvas: HTMLCanvasElement, maxAnisotropy: number): RobotModel {
  const root = new Group();
  const lift = new Group();
  const squash = new Group();
  const spin = new Group();
  root.add(lift);
  lift.add(squash);
  squash.position.y = -BODY.h / 2; // pivot at the feet
  squash.add(spin);
  spin.position.y = BODY.h / 2; // back up to the body centre

  const shellMat = new MeshPhysicalMaterial({
    color: THEMES["ivory-cyan"].shell,
    roughness: 0.52,
    clearcoat: 0.3,
    clearcoatRoughness: 0.45,
    sheen: 0.3,
    sheenRoughness: 0.7,
    sheenColor: new Color("#ffffff"),
  });
  const body = new Mesh(new RoundedBoxGeometry(BODY.w, BODY.h, BODY.d, 8, BODY.r), shellMat);
  spin.add(body);

  // Thin dark bezel, then the glass display on top of it.
  const bezel = new Mesh(
    roundedRect(SCREEN.w + 0.04, SCREEN.h + 0.04, SCREEN.r + 0.02),
    new MeshPhysicalMaterial({ color: "#16181b", roughness: 0.6 }),
  );
  bezel.position.z = BODY.d / 2 + 0.001;
  spin.add(bezel);

  const screenTexture = new CanvasTexture(displayCanvas);
  screenTexture.colorSpace = SRGBColorSpace;
  screenTexture.anisotropy = maxAnisotropy;
  screenTexture.minFilter = LinearMipmapLinearFilter;
  const screen = new Mesh(
    roundedRect(SCREEN.w, SCREEN.h, SCREEN.r),
    new MeshPhysicalMaterial({
      color: "#000000",
      roughness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      emissive: "#ffffff",
      emissiveMap: screenTexture,
      emissiveIntensity: 1.25,
    }),
  );
  screen.position.z = BODY.d / 2 + 0.003;
  spin.add(screen);

  // Charging port on the right side, like the reference.
  const port = new Mesh(roundedRect(0.2, 0.065, 0.03), new MeshPhysicalMaterial({ color: "#2b2e33", roughness: 0.5 }));
  port.rotation.y = Math.PI / 2;
  port.position.set(BODY.w / 2 + 0.002, -0.06, 0.04);
  spin.add(port);

  const shadow = new Mesh(
    new PlaneGeometry(2.0, 1.4),
    new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.55 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -BODY.h / 2 + 0.002;
  shadow.renderOrder = -1;
  root.add(shadow);

  function setTheme(theme: Theme): void {
    shellMat.color.set(theme.shell);
    shellMat.metalness = theme.metalness;
    shellMat.roughness = theme.roughness;
    shellMat.clearcoat = theme.clearcoat;
    shellMat.sheen = theme.metalness > 0 ? 0 : 0.3;
  }

  return { root, lift, squash, spin, body, screen, shadow, screenTexture, setTheme };
}

/** A flat rounded rectangle with 0..1 UVs across its bounds. */
function roundedRect(w: number, h: number, r: number): ShapeGeometry {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const geo = new ShapeGeometry(s, 10);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - x) / w, (pos.getY(i) - y) / h);
  }
  uv.needsUpdate = true;
  return geo;
}

function shadowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.45, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}
