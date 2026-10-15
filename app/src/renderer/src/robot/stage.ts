// stage.ts — renderer, camera and lighting. Transparent background; soft
// studio lighting from an environment map plus one key light, so the shell
// reads as real plastic and the display as glass.

import {
  DirectionalLight,
  HemisphereLight,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Layout } from "../../../shared/types";

/** Camera distance and angle: a slight three-quarter view from above, like a product shot. */
const DISTANCE = 7.4;
const AZIMUTH = 0.3; // radians to the right
const ELEVATION = 0.24; // radians up

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private layout!: Layout;
  private shift = { dx: 0, dy: 0 };

  constructor(canvas: HTMLCanvasElement, layout: Layout) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();

    const key = new DirectionalLight(0xffffff, 1.5);
    key.position.set(-2.2, 4, 3.2);
    this.scene.add(key);
    this.scene.add(new HemisphereLight(0xffffff, 0xcfc8bc, 0.35));

    this.camera = new PerspectiveCamera(26, 1, 0.1, 50);
    this.camera.position.set(
      DISTANCE * Math.sin(AZIMUTH) * Math.cos(ELEVATION),
      DISTANCE * Math.sin(ELEVATION),
      DISTANCE * Math.cos(AZIMUTH) * Math.cos(ELEVATION),
    );
    this.camera.lookAt(0, 0, 0);
    this.setLayout(layout);
  }

  /** New window size / robot size (tray → Size). */
  setLayout(layout: Layout): void {
    this.layout = layout;
    const { width, height } = layout.window;
    // Field of view chosen so the robot comes out at exactly pxPerUnit,
    // whatever the window height (the window never shrinks below what the
    // speech bubble needs, so it isn't always proportional to the robot).
    this.camera.fov = (2 * Math.atan(height / (2 * DISTANCE * layout.pxPerUnit)) * 180) / Math.PI;
    this.camera.aspect = width / height;
    this.setShift(this.shift.dx, this.shift.dy);
    this.resize();
  }

  /**
   * Shift the picture so the robot's centre lands on the layout's anchor +
   * (dx, dy) px. At rest that's the lower half of the window (headroom for
   * jumps and the bubble); when peeking it pushes the robot past the window edge.
   */
  setShift(dx: number, dy: number): void {
    this.shift = { dx, dy };
    const { width, height } = this.layout.window;
    const { anchor } = this.layout;
    this.camera.setViewOffset(width, height, width / 2 - anchor.x - dx, height / 2 - anchor.y - dy, width, height);
  }

  resize(): void {
    const { width, height } = this.layout.window;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Where an object (plus `up` scene units above it) is in the window, CSS px. */
  project(obj: Object3D, up = 0): { x: number; y: number } {
    const v = obj.getWorldPosition(new Vector3());
    v.y += up;
    v.project(this.camera);
    const { width, height } = this.layout.window;
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  }

  /** Is the window point (CSS px) over any of the given objects? */
  hits(x: number, y: number, objects: Object3D[]): boolean {
    const { width, height } = this.layout.window;
    const ndc = new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, false).length > 0;
  }
}
