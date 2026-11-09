/**
 * The building's explode value (0-1 of a storey) kept outside React state,
 * so a slider step or the Animate levels tween never re-renders the editor
 * or the 3D scene. The level panel reads it for the slider; the 3D scene
 * eases its level groups toward it inside the frame loop
 * (floorplan3d/level-explode-3d.tsx). No three.js here - the level panel
 * lives in the 2D chunk.
 */

export interface ExplodeStore {
  /** The value the slider shows and the levels ease toward. */
  get: () => number
  /** Set it now; stops a running animation. */
  set: (v: number) => void
  /** Tween it to `to` over `ms` with ease-in-out; `onDone` when it lands. */
  animateTo: (to: number, ms: number, onDone?: () => void) => void
  /** Where a running animation is heading; null when none runs. */
  animating: () => number | null
  stop: () => void
  subscribe: (fn: () => void) => () => void
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Cubic ease-in-out over t in 0-1. */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** How long the levels take to close up or spread out over the full
 * travel, ms. */
export const ANIMATE_LEVELS_MS = 4000

export function createExplodeStore(initial = 0): ExplodeStore {
  let value = clamp01(initial)
  let raf: number | null = null
  let heading: number | null = null
  const subs = new Set<() => void>()
  const emit = () => {
    for (const fn of subs) fn()
  }
  const stop = () => {
    if (raf != null) cancelAnimationFrame(raf)
    raf = null
    heading = null
  }
  return {
    get: () => value,
    set(v) {
      stop()
      const next = clamp01(v)
      if (next === value) return
      value = next
      emit()
    },
    animateTo(to, ms, onDone) {
      stop()
      const from = value
      const end = clamp01(to)
      if (from === end || ms <= 0) {
        value = end
        emit()
        onDone?.()
        return
      }
      heading = end
      const t0 = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / ms)
        value = from + (end - from) * easeInOutCubic(t)
        if (t >= 1) {
          value = end
          raf = null
          heading = null
        } else raf = requestAnimationFrame(tick)
        emit()
        if (t >= 1) onDone?.()
      }
      raf = requestAnimationFrame(tick)
      emit()
    },
    animating: () => heading,
    stop() {
      if (heading == null) return
      stop()
      emit()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

/** Animate levels: where the next press sends the levels - back the other
 * way while one runs, else closed up from the spread and spread out from
 * closed. */
export function nextAnimateTarget(store: ExplodeStore): number {
  const heading = store.animating()
  if (heading != null) return heading > 0.5 ? 0 : 1
  return store.get() >= 0.5 ? 0 : 1
}

/** Ease `current` toward `target` by `dt` seconds of exponential smoothing
 * with half-life `halfLife` s: frame-rate independent (two steps of dt/2
 * land where one step of dt does), and it snaps the last hair so the
 * demand frameloop can stop. */
export function smoothToward(
  current: number,
  target: number,
  dt: number,
  halfLife = 0.09
): number {
  if (current === target) return target
  const k = 1 - Math.pow(2, -Math.max(0, dt) / halfLife)
  const next = current + (target - current) * k
  return Math.abs(target - next) < 1e-4 ? target : next
}
