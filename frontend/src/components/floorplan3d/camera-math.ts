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
 * ground plane; PageUp/PageDown and Q/E change height.
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

/**
 * Vertical motion (PageUp/PageDown, Q/E) runs at this fraction of the
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
    (pressed.has("PageDown") || pressed.has("Shift") ? 1 : 0)
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

  const speed = Math.min(
    MAX_SPEED,
    Math.max(MIN_SPEED, distance * SPEED_PER_DISTANCE)
  )
  const horizontal = speed * dt
  const vertical = speed * VERTICAL_FACTOR * dt
  return [hx * horizontal, lift * vertical, hz * horizontal]
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
