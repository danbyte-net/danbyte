/**
 * Is the camera moving right now?
 *
 * Module-level on purpose (not context/state): every rack reads it inside
 * `useFrame`, dozens of times per frame, and it must never itself cause a
 * React render - that is the exact problem it exists to solve.
 *
 * Why it exists: each cabinet swaps LOD tier through `useState`, so crossing a
 * threshold re-renders that rack (and, in the detail tier, its two dozen
 * devices). Walking down an aisle crosses thresholds continuously, so a held
 * nav key produced a rolling cascade of React reconciliation - measured at
 * 130–800 ms per keypress, which is what "laggy" actually was. Deferring the
 * swaps until the camera settles means motion costs draw calls only.
 */

/** ms of stillness before the room is allowed to re-tier. Long enough to span
 * key auto-repeat and wheel bursts, short enough to feel immediate. */
const SETTLE_MS = 180

let movingUntil = 0

/** Called by the camera rig on every frame it moves the camera. */
export function markCameraMoving(): void {
  movingUntil = performance.now() + SETTLE_MS
}

export function isCameraMoving(): boolean {
  return performance.now() < movingUntil
}

/** Still inside the settle window (motion plus a `tailMs` grace)? The rig
 * keeps invalidating while this holds, so the frames that let racks apply
 * their deferred tier/panel swaps ALWAYS arrive - whatever moved the camera.
 * Key-release used to schedule that trailing frame itself (and nothing else
 * did), which left every other motion source - wheel bursts, drags - able to
 * end with pending swaps frozen until the next interaction. */
export function isCameraSettling(tailMs = 200): boolean {
  return performance.now() < movingUntil + tailMs
}
