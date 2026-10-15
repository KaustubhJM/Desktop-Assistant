// edges.ts — which screen edge to peek from, and where the window goes.
// Pure functions (no Electron calls) so they can be tested against made-up
// monitor layouts.

import type { Point, Rectangle } from "electron";
import type { Edge, Layout } from "../shared/types";

export interface DisplayLike {
  bounds: Rectangle;
  workArea: Rectangle;
}

const MARGIN = 8;
const TOUCH = 2; // px tolerance when deciding two monitors touch

/**
 * Pick the nearest of the current display's left, right and bottom edges,
 * avoiding edges that butt against another monitor (peeking "into" the
 * next screen looks wrong). Sides are slightly preferred over the bottom.
 */
export function chooseEdge(robotCentre: Point, display: DisplayLike, all: DisplayLike[]): Edge {
  const wa = display.workArea;
  const candidates: [Edge, number][] = [
    ["left", robotCentre.x - wa.x],
    ["right", wa.x + wa.width - robotCentre.x],
    ["bottom", (wa.y + wa.height - robotCentre.y) * 1.25],
  ];
  let best: Edge = "right";
  let bestScore = Infinity;
  for (const [edge, distance] of candidates) {
    const score = distance + (isInnerEdge(edge, display, all, robotCentre) ? 1e6 : 0);
    if (score < bestScore) {
      best = edge;
      bestScore = score;
    }
  }
  return best;
}

/** True if another monitor sits right against this edge (and no taskbar is in between). */
export function isInnerEdge(edge: Edge, display: DisplayLike, all: DisplayLike[], p: Point): boolean {
  const b = display.bounds;
  const wa = display.workArea;
  return all.some((other) => {
    if (other === display) return false;
    const o = other.bounds;
    switch (edge) {
      case "right":
        return wa.x + wa.width === b.x + b.width && Math.abs(o.x - (b.x + b.width)) <= TOUCH && p.y >= o.y && p.y <= o.y + o.height;
      case "left":
        return wa.x === b.x && Math.abs(o.x + o.width - b.x) <= TOUCH && p.y >= o.y && p.y <= o.y + o.height;
      case "bottom":
        return wa.y + wa.height === b.y + b.height && Math.abs(o.y - (b.y + b.height)) <= TOUCH && p.x >= o.x && p.x <= o.x + o.width;
    }
  });
}

/** Window top-left that puts the window flush against `edge` of the work area. */
export function peekWindowPosition(edge: Edge, pos: Point, wa: Rectangle, layout: Layout): Point {
  const { box, window: win } = layout;
  const minX = wa.x + MARGIN - box.x;
  const maxX = wa.x + wa.width - MARGIN - (box.x + box.width);
  const minY = wa.y + MARGIN - box.y;
  const maxY = wa.y + wa.height - MARGIN - (box.y + box.height);
  switch (edge) {
    case "right":
      return { x: wa.x + wa.width - win.width, y: clamp(pos.y, minY, maxY) };
    case "left":
      return { x: wa.x, y: clamp(pos.y, minY, maxY) };
    case "bottom":
      return { x: clamp(pos.x, minX, maxX), y: wa.y + wa.height - win.height };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));
}
