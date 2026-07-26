/**
 * Is the camera moving right now?
 *
 * Module-level on purpose (not context/state): every rack reads it inside
 * `useFrame`, dozens of times per frame, and it must never itself cause a
 * React render — that is the exact problem it exists to solve.
 *
 * Why it exists: each cabinet swaps LOD tier through `useState`, so crossing a
 * threshold re-renders that rack (and, in the detail tier, its two dozen
 * devices). Walking down an aisle crosses thresholds continuously, so a held
 * nav key produced a rolling cascade of React reconciliation — measured at
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

/** How long until the camera counts as settled (ms, 0 if already still) —
 * lets the rig schedule the one trailing frame that applies pending swaps. */
export function settleDelayMs(): number {
  return Math.max(0, movingUntil - performance.now())
}
