/**
 * Pure keyboard-navigation math for the 3D room camera. No three.js imports -
 * everything here is plain tuples so it stays unit-testable; `camera-rig.tsx`
 * owns the DOM listeners and the actual camera/orbit-target mutation.
 *
 * Key names are `KeyboardEvent.key` values passed through `normalizeKey`
 * (single characters lowercased, so `Shift+W` and `w` collapse to `"w"`).
 */

/**
 * Every key that drives the camera. Forward/back/strafe pan parallel to the
 * ground plane; Space/PageUp rise, C/PageDown descend, Shift sprints.
 */
export const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "w",
  "ArrowDown",
  "s",
  "ArrowLeft",
  "a",
  "ArrowRight",
  "d",
  "PageUp",
  " ",
  "PageDown",
  "c",
  "Shift",
])

/**
 * Nav keys whose browser default scrolls the page - these get
 * `preventDefault()` while the 3D view is driving. Letters are absent on
 * purpose: w/a/s/d and Shift have no default worth suppressing.
 */
export const PAGE_SCROLL_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  " ",
])

/**
 * Canonical form of a `KeyboardEvent.key` for the pressed-set: single
 * characters lowercase (so a `keyup` of `"W"` releases the `"w"` a plain
 * keydown registered), named keys (`"ArrowUp"`, `"PageDown"`) unchanged.
 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

/**
 * Pan speed in m/s per metre of camera→target distance. Tying speed to the
 * orbit distance means close-up inspection moves in fine steps while a
 * zoomed-out hall crossing is quick.
 */
const SPEED_PER_DISTANCE = 0.9

/** Speed floor (m/s) so navigation never stalls when zoomed onto a single U. */
const MIN_SPEED = 1.5

/** Speed ceiling (m/s) so a fully zoomed-out view stays controllable. */
const MAX_SPEED = 40

/** Holding Shift multiplies the speed - a sprint through the aisles. */
export const SPRINT_FACTOR = 4

/** Absolute ceiling with sprint applied - a zoomed-out sprint stays sane. */
const SPRINT_MAX_SPEED = 80

/**
 * Vertical motion (Space/C, PageUp/PageDown) runs at this fraction of the
 * horizontal speed - the room is far wider than it is tall.
 */
const VERTICAL_FACTOR = 0.6

/** Below this squared length a horizontal direction is treated as zero. */
const EPSILON_SQ = 1e-12

/**
 * World-space camera translation for one frame of keyboard navigation.
 *
 * @param pressed  Held keys, already `normalizeKey`-ed. Non-nav keys ignored.
 * @param forward  Camera→orbit-target direction projected onto the ground
 *                 plane, as a unit `[x, z]` tuple (`[0, 0]` when degenerate -
 *                 horizontal motion is then suppressed, vertical still works).
 * @param distance Camera→orbit-target distance in metres (speed scale).
 * @param dt       Frame delta in seconds.
 * @returns `[dx, dy, dz]` world-space delta in metres; `[0, 0, 0]` when no
 *          nav key is held or opposing keys cancel out. Diagonals are
 *          normalized so two keys are never faster than one.
 */
export function panVector(
  pressed: ReadonlySet<string>,
  forward: [number, number],
  distance: number,
  dt: number
): [number, number, number] {
  // Booleans, not sums: ArrowUp + w together is still one "forward".
  const ahead =
    (pressed.has("ArrowUp") || pressed.has("w") ? 1 : 0) -
    (pressed.has("ArrowDown") || pressed.has("s") ? 1 : 0)
  const strafe =
    (pressed.has("ArrowRight") || pressed.has("d") ? 1 : 0) -
    (pressed.has("ArrowLeft") || pressed.has("a") ? 1 : 0)
  const lift =
    (pressed.has("PageUp") || pressed.has(" ") ? 1 : 0) -
    (pressed.has("PageDown") || pressed.has("c") ? 1 : 0)
  if (ahead === 0 && strafe === 0 && lift === 0) return [0, 0, 0]

  const [fx, fz] = forward
  // Strafe axis = forward × world-up in y-up right-handed coords: (-fz, fx).
  let hx = ahead * fx + strafe * -fz
  let hz = ahead * fz + strafe * fx
  // Normalize so a diagonal (forward + strafe) isn't ×√2 faster.
  const hSq = hx * hx + hz * hz
  if (hSq > EPSILON_SQ) {
    const inv = 1 / Math.sqrt(hSq)
    hx *= inv
    hz *= inv
  } else {
    hx = 0
    hz = 0
  }

  const base = Math.min(
    MAX_SPEED,
    Math.max(MIN_SPEED, distance * SPEED_PER_DISTANCE)
  )
  const speed = pressed.has("Shift")
    ? Math.min(SPRINT_MAX_SPEED, base * SPRINT_FACTOR)
    : base
  const horizontal = speed * dt
  const vertical = speed * VERTICAL_FACTOR * dt
  return [hx * horizontal, lift * vertical, hz * horizontal]
}

// ─── Zoom freedom ────────────────────────────────────────────────────────────

/** Closest the orbit arm may get (m) - inside this, wheel becomes a walk. */
export const MIN_DISTANCE_M = 0.05

/** One full wheel tick at the wall walks the camera this far forward (m). */
export const DOLLY_THROUGH_STEP_M = 0.35

/** Wheel-in within this multiple of MIN_DISTANCE_M converts to a walk. */
const DOLLY_THROUGH_AT = 1.2

/**
 * The "zoom stops working" fix. OrbitControls' dolly is multiplicative - each
 * tick scales the arm by ~0.95, so steps collapse to nothing near
 * `minDistance` and then hit its hard wall. When a wheel-IN arrives with the
 * arm already at that wall, this returns a world-space translation that walks
 * camera AND target forward along the sight line instead (orbit becomes fly,
 * straight through the rack and into the next aisle). `null` = not our event,
 * let OrbitControls dolly normally.
 *
 * Step scales with |deltaY| so pixel-mode trackpads glide instead of leaping
 * (a full 100-unit line-mode tick gets the whole step, floored at 5%).
 */
export function dollyThroughStep(
  cam: readonly [number, number, number],
  target: readonly [number, number, number],
  deltaY: number,
  distance: number,
  threshold: number = MIN_DISTANCE_M * DOLLY_THROUGH_AT
): [number, number, number] | null {
  if (deltaY >= 0 || distance > threshold) return null
  const dx = target[0] - cam[0]
  const dy = target[1] - cam[1]
  const dz = target[2] - cam[2]
  const d = Math.hypot(dx, dy, dz)
  if (d === 0) return null
  const step =
    DOLLY_THROUGH_STEP_M * Math.min(1, Math.max(0.05, Math.abs(deltaY) / 100))
  const k = step / d
  return [dx * k, dy * k, dz * k]
}

/**
 * Near-plane for the current orbit distance: 1 cm when nose-on a faceplate,
 * 0.5 m across the hall. A FIXED near that small would burn the depth buffer's
 * far-field precision - the zone patches sit 3 mm above the slab and would
 * shimmer from across the room. Scaling near with distance serves both ends.
 */
export function nearForDistance(distance: number): number {
  // 2 % of the orbit distance: 1 cm nose-on, 0.5 m across a hall, and on a
  // site-sized plan seen from hundreds of metres far enough out that layers
  // millimetres apart (floor, map, area tints) keep their depth order.
  return Math.min(25, Math.max(0.01, distance * 0.02))
}

// ─── FPS-feel pivot ──────────────────────────────────────────────────────────

/**
 * When keyboard navigation starts, the orbit target is pulled to this many
 * metres in front of the camera, so an Alt-drag (orbit about the target)
 * looks around first-person-style instead of swinging the camera around a
 * far-away rack, and the key speed matches the near view. A fly-to still
 * re-anchors the target on what it frames.
 */
export const NEAR_PIVOT_M = 3

/**
 * The pulled-in target: `maxDist` metres from `cam` along the current sight
 * line, or `null` when the target is already at least that close (pulling a
 * near pivot would zoom the view). Pure tuples - unit-testable.
 */
export function pullInTarget(
  cam: readonly [number, number, number],
  target: readonly [number, number, number],
  maxDist: number = NEAR_PIVOT_M
): [number, number, number] | null {
  const dx = target[0] - cam[0]
  const dy = target[1] - cam[1]
  const dz = target[2] - cam[2]
  const d = Math.hypot(dx, dy, dz)
  if (d <= maxDist || d === 0) return null
  const k = maxDist / d
  return [cam[0] + dx * k, cam[1] + dy * k, cam[2] + dz * k]
}

// ─── Navigation engine: zoom to cursor, orbit and pan at scale ──────────────
//
// Plain tuples throughout, like the key math above: `camera-rig.tsx` turns
// pointer events into rays and anchors, these turn anchors into camera moves.

export type Vec3 = readonly [number, number, number]
type V3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: Vec3): V3 => {
  const l = len(a)
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0]
}

/** Share of the distance to the point under the cursor one wheel notch
 * covers. Proportional, so a notch feels the same 2 km out and 2 m out. */
export const ZOOM_RATE = 0.2

/** The least one notch moves (m), so the last metres never crawl. */
export const MIN_ZOOM_STEP_M = 0.04

/**
 * A wheel event as notches: 1 = one line-mode mouse tick (100 px). Pixel
 * trackpads arrive as fractions and glide; a trackpad pinch (ctrl+wheel)
 * reports small deltas and gets doubled. Clamped so one event never jumps.
 * Negative = zoom in.
 */
export function wheelNotches(
  deltaY: number,
  deltaMode: number,
  pinch = false
): number {
  const px =
    deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY
  const n = (px / 100) * (pinch ? 2 : 1)
  return Math.max(-4, Math.min(4, n))
}

/**
 * The camera's new position after `notches` of zoom toward (negative) or
 * away from (positive) `anchor`, the point under the cursor. The camera
 * moves along the cursor ray, so the anchor stays under the cursor.
 *
 * In: each notch covers `rate` of the remaining distance, at least
 * `MIN_ZOOM_STEP_M`, and never closer than `minGap` - the camera stops at
 * the surface instead of passing through it. Out: the inverse, up to
 * `maxDist` from the anchor.
 */
export function zoomTowards(
  cam: Vec3,
  anchor: Vec3,
  notches: number,
  opts: { minGap: number; maxDist: number; rate?: number }
): V3 {
  const rate = opts.rate ?? ZOOM_RATE
  const toAnchor = sub(anchor, cam)
  const d = len(toAnchor)
  if (d < 1e-9 || notches === 0) return [cam[0], cam[1], cam[2]]
  const dir = scale(toAnchor, 1 / d)
  const n = Math.abs(notches)
  if (notches < 0) {
    let step = d * (1 - (1 - rate) ** n)
    step = Math.max(step, MIN_ZOOM_STEP_M * n)
    step = Math.min(step, d - opts.minGap)
    if (step <= 0) return [cam[0], cam[1], cam[2]]
    return add(cam, scale(dir, step))
  }
  let next = d / (1 - rate) ** n
  next = Math.max(next, d + MIN_ZOOM_STEP_M * n)
  next = Math.min(next, Math.max(d, opts.maxDist))
  return sub(anchor, scale(dir, next))
}

/**
 * The orbit target for a camera looking along `forward`: on the sight
 * line at the depth of `anchor`, so the view does not turn, yet the pivot
 * sits where the operator just zoomed or panned. Never nearer than `min`.
 */
export function targetAtDepth(
  cam: Vec3,
  forward: Vec3,
  anchor: Vec3,
  min: number
): V3 {
  const depth = Math.max(min, dot(sub(anchor, cam), forward))
  return add(cam, scale(forward, depth))
}

/** Polar range of the camera about its pivot (rad from straight above):
 * never quite overhead (the view would spin), a hair short of straight up. */
export const MIN_POLAR = 0.02
export const MAX_POLAR = Math.PI - 0.05

/** Rotate `v` about the unit `axis` by `angle` (Rodrigues). */
function rotate(v: Vec3, axis: Vec3, angle: number): V3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = dot(axis, v) * (1 - c)
  const x = cross(axis, v)
  return [
    v[0] * c + x[0] * s + axis[0] * k,
    v[1] * c + x[1] * s + axis[1] * k,
    v[2] * c + x[2] * s + axis[2] * k,
  ]
}

/**
 * Orbit the camera AND its target rigidly about `pivot`: `yaw` turns about
 * the world vertical, `pitch` tips the view (positive = camera lower). The
 * pivot need not be the target - it is whatever was under the cursor on
 * press - and because the target turns with the camera, the camera still
 * looks at it afterwards. Pitch is clamped to the polar range.
 */
export function orbitAround(
  cam: Vec3,
  target: Vec3,
  pivot: Vec3,
  yaw: number,
  pitch: number
): { cam: V3; target: V3 } {
  const up: V3 = [0, 1, 0]
  let c = add(pivot, rotate(sub(cam, pivot), up, yaw))
  let t = add(pivot, rotate(sub(target, pivot), up, yaw))
  const f = unit(sub(t, c))
  if (len(f) === 0) return { cam: c, target: t }
  const phi = Math.acos(Math.max(-1, Math.min(1, -f[1])))
  const nextPhi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, phi + pitch))
  const dp = nextPhi - phi
  const right = unit(cross(f, up))
  if (dp !== 0 && len(right) > 0) {
    c = add(pivot, rotate(sub(c, pivot), right, dp))
    t = add(pivot, rotate(sub(t, pivot), right, dp))
  }
  return { cam: c, target: t }
}

/** Where a ray meets a plane: the distance along the (unit) ray, or null
 * when it runs parallel or the plane is behind. */
export function rayPlane(
  origin: Vec3,
  dir: Vec3,
  point: Vec3,
  normal: Vec3
): number | null {
  const den = dot(dir, normal)
  if (Math.abs(den) < 1e-6) return null
  const t = dot(sub(point, origin), normal) / den
  return t > 0 ? t : null
}

/**
 * The plane a pan drags along: level through the grabbed point while the
 * view looks down at least ~12°, else facing the camera - a level plane
 * seen edge-on would fling the camera to the horizon.
 */
export function panPlaneNormal(forward: Vec3): V3 {
  return forward[1] < -0.2 ? [0, 1, 0] : unit(scale(forward, -1))
}

/**
 * Grab-pan: the camera offset that puts `grab` back under the cursor.
 * `cam0` is the camera when the drag began and `dir` the (unit) ray through
 * the cursor now - the camera only translates, so the ray for a pixel keeps
 * its direction. `maxReach` caps how far along the ray the plane may be met
 * (a cursor near the horizon). Null when the ray misses the plane.
 */
export function panOffset(
  cam0: Vec3,
  dir: Vec3,
  grab: Vec3,
  normal: Vec3,
  maxReach: number
): V3 | null {
  const t = rayPlane(cam0, dir, grab, normal)
  if (t == null) return null
  const hit = add(cam0, scale(dir, Math.min(t, maxReach)))
  return sub(grab, hit)
}

/**
 * The direction from a framed object back to the camera: the camera's
 * current heading kept (no swing around the object), raised `elevation`
 * radians above level. `forward` is the camera's sight line.
 */
export function viewDirection(forward: Vec3, elevation: number): V3 {
  let hx = forward[0]
  let hz = forward[2]
  const h = Math.hypot(hx, hz)
  if (h < 1e-6) {
    hx = 0
    hz = -1
  } else {
    hx /= h
    hz /= h
  }
  const ce = Math.cos(elevation)
  return [-hx * ce, Math.sin(elevation), -hz * ce]
}

/**
 * The camera that frames the box `min`..`max` seen along `dir` (unit, from
 * the box toward the camera): target at the box centre, eye backed off just
 * far enough that every corner, grown by `margin`, lands inside the frustum
 * of a `fovY` (rad) camera with this `aspect`. Never nearer than `minDist`.
 */
export function frameBox(
  min: Vec3,
  max: Vec3,
  dir: Vec3,
  fovY: number,
  aspect: number,
  opts: { margin?: number; minDist?: number } = {}
): { target: V3; position: V3 } {
  const margin = opts.margin ?? 1.15
  const centre: V3 = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ]
  const back = unit(dir)
  const forward = scale(back, -1)
  let right = unit(cross(forward, [0, 1, 0]))
  if (len(right) === 0) right = [1, 0, 0]
  const up = cross(right, forward)
  const tanY = Math.tan(fovY / 2)
  const tanX = tanY * Math.max(aspect, 1e-3)
  let dist = opts.minDist ?? 0
  for (let i = 0; i < 8; i++) {
    const corner: V3 = [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ]
    const v = sub(corner, centre)
    const x = Math.abs(dot(v, right)) * margin
    const y = Math.abs(dot(v, up)) * margin
    const z = dot(v, back)
    dist = Math.max(dist, z + x / tanX, z + y / tanY)
  }
  return { target: centre, position: add(centre, scale(back, dist)) }
}

/** Seconds a fly-to takes: longer hops a little longer, never sluggish. */
export function flyDuration(travel: number): number {
  return Math.min(1.1, 0.55 + 0.1 * Math.log1p(Math.max(0, travel)))
}

export interface Fly {
  fromPos: Vec3
  fromTarget: Vec3
  toPos: Vec3
  toTarget: Vec3
  /** Seconds; 0 jumps (reduced motion). */
  duration: number
  /** Seconds elapsed. */
  t: number
}

/**
 * One frame of a fly-to, eased in and out. A zero duration - what a
 * reduced-motion preference asks for - lands at once.
 */
export function advanceFly(
  fly: Fly,
  dt: number
): { pos: V3; target: V3; t: number; done: boolean } {
  const t = fly.duration > 0 ? Math.min(fly.duration, fly.t + dt) : 0
  const p = fly.duration > 0 ? t / fly.duration : 1
  const k = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2
  const lerp = (a: Vec3, b: Vec3): V3 => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ]
  return {
    pos: lerp(fly.fromPos, fly.toPos),
    target: lerp(fly.fromTarget, fly.toTarget),
    t,
    done: p >= 1,
  }
}
