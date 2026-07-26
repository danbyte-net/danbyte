/**
 * Pure keyboard-navigation math for the 3D room camera. No three.js imports —
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
 * Nav keys whose browser default scrolls the page — these get
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

/** Holding Shift multiplies the speed — a sprint through the aisles. */
export const SPRINT_FACTOR = 4

/** Absolute ceiling with sprint applied — a zoomed-out sprint stays sane. */
const SPRINT_MAX_SPEED = 80

/**
 * Vertical motion (Space/C, PageUp/PageDown) runs at this fraction of the
 * horizontal speed — the room is far wider than it is tall.
 */
const VERTICAL_FACTOR = 0.6

/** Below this squared length a horizontal direction is treated as zero. */
const EPSILON_SQ = 1e-12

/**
 * World-space camera translation for one frame of keyboard navigation.
 *
 * @param pressed  Held keys, already `normalizeKey`-ed. Non-nav keys ignored.
 * @param forward  Camera→orbit-target direction projected onto the ground
 *                 plane, as a unit `[x, z]` tuple (`[0, 0]` when degenerate —
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

/** Closest the orbit arm may get (m) — inside this, wheel becomes a walk. */
export const MIN_DISTANCE_M = 0.05

/** One full wheel tick at the wall walks the camera this far forward (m). */
export const DOLLY_THROUGH_STEP_M = 0.35

/** Wheel-in within this multiple of MIN_DISTANCE_M converts to a walk. */
const DOLLY_THROUGH_AT = 1.2

/**
 * The "zoom stops working" fix. OrbitControls' dolly is multiplicative — each
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
 * far-field precision — the zone patches sit 3 mm above the slab and would
 * shimmer from across the room. Scaling near with distance serves both ends.
 */
export function nearForDistance(distance: number): number {
  return Math.min(0.5, Math.max(0.01, distance * 0.02))
}

/**
 * OrbitControls zoomSpeed scaled by room size, so a 3-rack closet and a
 * 400-rack hall take about the same number of wheel ticks end to end.
 */
export function zoomSpeedForRoom(diag: number): number {
  return Math.min(2, Math.max(1, 1 + diag / 120))
}

// ─── FPS-feel pivot ──────────────────────────────────────────────────────────

/**
 * When keyboard navigation starts, the orbit target is pulled to this many
 * metres in front of the camera, so drag-look rotates around a NEAR point
 * (first-person feel) instead of swinging the camera around a far-away rack,
 * and scroll-zoom reads as "move forward". Rack double-click fly-to still
 * re-anchors the pivot on the rack, so orbit-to-inspect is unchanged.
 */
export const NEAR_PIVOT_M = 3

/**
 * The pulled-in target: `maxDist` metres from `cam` along the current sight
 * line, or `null` when the target is already at least that close (pulling a
 * near pivot would zoom the view). Pure tuples — unit-testable.
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
