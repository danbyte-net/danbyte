/**
 * Pure maths for the 3D views' shared camera (camera-rig.tsx): the pivot a
 * click sets, screen-plane pan, trackpad wheel gestures, orthographic zoom
 * at the cursor, the orbit's polar limit, the eased approach to a goal,
 * the pivot marker's fade and the clip planes. Plain tuples, no three.js,
 * so every rule here is unit-tested (camera-nav.test.ts).
 */

import { orbitAround, targetAtDepth } from "./camera-math"
import type { Vec3 } from "./camera-math"

type V3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

// ─── Pivot ───────────────────────────────────────────────────────────────────

/**
 * A click on a surface at `hit`: the orbit turns about that point from now
 * on, and the camera does not move. The orbit target slides along the
 * sight line to the hit's depth (`forward` is the camera's unit sight
 * line), so the view direction - and the picture - stays exactly as it is.
 */
export function clickPivot(
  cam: Vec3,
  forward: Vec3,
  hit: Vec3,
  minDepth: number
): { pivot: V3; target: V3 } {
  return {
    pivot: [hit[0], hit[1], hit[2]],
    target: targetAtDepth(cam, forward, hit, minDepth),
  }
}

/** Whether a point projected to normalised device coordinates is on
 * screen and in front of the camera. */
export function inView(ndc: Vec3): boolean {
  return (
    Math.abs(ndc[0]) <= 1 &&
    Math.abs(ndc[1]) <= 1 &&
    ndc[2] >= -1 &&
    ndc[2] <= 1
  )
}

// ─── Orbit ───────────────────────────────────────────────────────────────────

/** Angle (rad) of `v` from straight up: 0 overhead, π/2 level, π below. */
export function polarOf(v: Vec3): number {
  const l = len(v)
  if (l === 0) return 0
  return Math.acos(Math.max(-1, Math.min(1, v[1] / l)))
}

/** The room's and racks' limit: the camera stays above the pivot's
 * horizon (85° from overhead), so an orbit never sinks under the floor. */
export const FLOOR_MAX_POLAR = (85 * Math.PI) / 180

/** A single model may be seen from below: just short of straight under. */
export const MODEL_MAX_POLAR = Math.PI - 0.05

/**
 * `orbitAround` (yaw about the vertical, `pitch` tipping the view - the
 * horizon stays level, there is no roll), with the tilt limited so the
 * camera's angle about `pivot` stays within `maxPolar` from overhead and
 * the camera at or above `minY`. A tilt past the limit stops at it, never
 * snaps back; a camera already past it (a fly-to, a walk) may only tilt
 * back toward the allowed range.
 */
export function orbitLimited(
  cam: Vec3,
  target: Vec3,
  pivot: Vec3,
  yaw: number,
  pitch: number,
  opts: { maxPolar: number; minY?: number }
): { cam: V3; target: V3 } {
  const minY = opts.minY ?? -Infinity
  const before = polarOf(sub(cam, pivot))
  const ok = (r: { cam: V3 }) => {
    const p = polarOf(sub(r.cam, pivot))
    // Tilting back toward the range is always allowed.
    if (p > opts.maxPolar && p > before + 1e-9) return false
    if (r.cam[1] < minY && r.cam[1] < cam[1] - 1e-9) return false
    return true
  }
  const full = orbitAround(cam, target, pivot, yaw, pitch)
  if (ok(full)) return full
  // Bisect the tilt down to the limit.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (ok(orbitAround(cam, target, pivot, yaw, pitch * mid))) lo = mid
    else hi = mid
  }
  const r = orbitAround(cam, target, pivot, yaw, pitch * lo)
  return ok(r) ? r : orbitAround(cam, target, pivot, yaw, 0)
}

// ─── Pan ─────────────────────────────────────────────────────────────────────

/**
 * World units one screen pixel covers at `depth` along the sight line: a
 * perspective camera of vertical field of view `fovY` (rad), or an
 * orthographic one whose view is `viewHeight` world units tall at zoom 1.
 */
export function worldPerPixel(
  proj:
    | { kind: "perspective"; fovY: number; depth: number }
    | { kind: "orthographic"; viewHeight: number; zoom: number },
  heightPx: number
): number {
  const h = Math.max(1, heightPx)
  if (proj.kind === "orthographic")
    return proj.viewHeight / Math.max(proj.zoom, 1e-9) / h
  return (2 * Math.max(proj.depth, 0) * Math.tan(proj.fovY / 2)) / h
}

/**
 * The camera's offset for a pan of `dx`, `dy` screen pixels (right, down):
 * a slide in the screen plane - along the camera's `right` and `up` - with
 * no turn. At `perPx` from `worldPerPixel` at the grabbed point's depth,
 * that point stays under the cursor.
 */
export function screenPan(
  dx: number,
  dy: number,
  perPx: number,
  right: Vec3,
  up: Vec3
): V3 {
  const a = -dx * perPx
  const b = dy * perPx
  return [
    right[0] * a + up[0] * b,
    right[1] * a + up[1] * b,
    right[2] * a + up[2] * b,
  ]
}

// ─── Wheel ───────────────────────────────────────────────────────────────────

export type WheelGesture = "zoom" | "pan"

/**
 * What a wheel event means. A pinch on a trackpad arrives as a wheel with
 * `ctrlKey` set: zoom. A two-finger swipe arrives in pixels with a
 * sideways component: pan. A mouse wheel (lines, or pixels straight up and
 * down) zooms. `latched` is what the burst this event belongs to already
 * was, so a swipe that drifts straight never flips to a zoom mid-gesture.
 */
export function classifyWheel(
  e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean },
  latched: WheelGesture | null
): WheelGesture {
  if (e.ctrlKey) return "zoom"
  if (latched) return latched
  if (e.deltaMode !== 0) return "zoom"
  return e.deltaX !== 0 ? "pan" : "zoom"
}

/** Zoom factor for an orthographic camera after `notches` of wheel (in is
 * negative): each notch the same share as a perspective dolly covers. */
export function orthoZoomFactor(notches: number, rate = 0.2): number {
  return (1 / (1 - rate)) ** -notches
}

/**
 * An orthographic zoom by `factor` at the cursor: the new zoom, and the
 * offset to move camera and target by so the point under the cursor (at
 * `ndc`) stays under it. `halfW` / `halfH` are the camera's frustum half
 * extents at zoom 1; `right` / `up` its screen axes.
 */
export function orthoZoomAt(
  ndc: readonly [number, number],
  halfW: number,
  halfH: number,
  zoom: number,
  factor: number,
  right: Vec3,
  up: Vec3
): { zoom: number; shift: V3 } {
  const next = Math.min(1e9, Math.max(1e-9, zoom * factor))
  const k = 1 / zoom - 1 / next
  const a = ndc[0] * halfW * k
  const b = ndc[1] * halfH * k
  return {
    zoom: next,
    shift: [
      right[0] * a + up[0] * b,
      right[1] * a + up[1] * b,
      right[2] * a + up[2] * b,
    ],
  }
}

// ─── Smoothing ───────────────────────────────────────────────────────────────

/** Time constant (s) of the eased approach to a gesture's goal: short
 * enough to track the hand, long enough to take the steps out. */
export const EASE_TAU = 0.06

/** Share of the way to the goal one frame of `dt` seconds covers. 1 lands
 * at once (reduced motion). */
export function easeShare(
  dt: number,
  reduced: boolean,
  tau = EASE_TAU
): number {
  if (reduced) return 1
  if (dt <= 0) return 0
  return 1 - Math.exp(-dt / tau)
}

/** Framing flights (double-click, F, 0, Front / Rear) take about this. */
export const FRAME_SECONDS = 0.3

// ─── Pivot marker ────────────────────────────────────────────────────────────

/** Seconds the marker takes to fade in, how long it stays, and its fade out. */
export const MARKER_FADE_IN = 0.6
export const MARKER_HOLD = 0.6
export const MARKER_FADE_OUT = 0.4

/**
 * The pivot marker's opacity `t` seconds after the pivot was set: fades in,
 * holds, fades out. Under reduced motion it shows at once and goes at once.
 * `held`: an orbit is turning about it - full while it lasts.
 */
export function markerOpacity(
  t: number,
  reduced: boolean,
  held = false
): number {
  if (held) return 1
  if (t < 0) return 0
  const end = MARKER_FADE_IN + MARKER_HOLD
  if (reduced) return t < end ? 1 : 0
  if (t < MARKER_FADE_IN) return t / MARKER_FADE_IN
  if (t < end) return 1
  if (t < end + MARKER_FADE_OUT) return 1 - (t - end) / MARKER_FADE_OUT
  return 0
}

// ─── Clip planes ─────────────────────────────────────────────────────────────

/**
 * The perspective camera's near plane. Its depth precision wants it as far
 * out as possible (layers millimetres apart on a site-sized floor), but it
 * must stay in front of the nearest thing in view: a near plane sized from
 * the orbit target alone cut away a cabinet door the camera stood beside
 * while the target lay metres off - the door's face sliced along the
 * diagonal where the plane crossed it.
 *
 * - `toTarget`: distance to the orbit target (2% of it).
 * - `toSurface`: distance to the nearest surface the rig has seen in view
 *   (a quarter of it), or Infinity when unknown.
 * - `height`: the camera's height over the floor (half of it), or Infinity.
 * - `far`: the far plane - the near plane never drops below 1/20,000 of
 *   it, or layers a few millimetres apart (floor zones, a door's infill on
 *   its frame) fight for the depth buffer and flicker.
 *
 * The result steps in powers of two, so it doesn't change every frame as
 * the camera moves (a depth mapping that shifts each frame makes close
 * layers shimmer).
 */
export function adaptiveNear(opts: {
  toTarget: number
  toSurface?: number
  height?: number
  min?: number
  far?: number
}): number {
  const want = Math.min(
    25,
    opts.toTarget * 0.02,
    (opts.toSurface ?? Infinity) * 0.5,
    Math.abs(opts.height ?? Infinity) * 0.5
  )
  const floor = Math.max(opts.min ?? 0.05, (opts.far ?? 0) / NEAR_FAR_RATIO)
  if (!(want > floor)) return floor
  return Math.max(floor, 2 ** Math.floor(Math.log2(want)))
}

/** The widest far : near the depth buffer resolves cleanly at room scale. */
export const NEAR_FAR_RATIO = 20000

/** The far plane: what the scene set, or further when the camera has
 * zoomed out beyond it - zoom has no limit, so neither may the far plane. */
export function adaptiveFar(toTarget: number, base: number): number {
  return Math.max(base, toTarget * 20)
}
