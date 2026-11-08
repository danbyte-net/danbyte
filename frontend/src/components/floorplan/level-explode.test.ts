// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createExplodeStore,
  easeInOutCubic,
  nextAnimateTarget,
  smoothToward,
} from "./level-explode"

describe("smoothToward", () => {
  it("converges on the target and lands on it exactly", () => {
    let v = 0
    for (let i = 0; i < 120; i++) v = smoothToward(v, 1, 1 / 60)
    expect(v).toBe(1)
    let w = 1
    for (let i = 0; i < 120; i++) w = smoothToward(w, 0.25, 1 / 60)
    expect(w).toBe(0.25)
  })

  it("moves monotonically, never past the target", () => {
    let v = 0
    let prev = v
    for (let i = 0; i < 30; i++) {
      v = smoothToward(v, 1, 1 / 30)
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeLessThanOrEqual(1)
      prev = v
    }
  })

  it("is frame-rate independent", () => {
    // Half a second at 30, 60 and 144 fps lands in the same place.
    const run = (fps: number) => {
      let v = 0
      for (let i = 0; i < fps / 2; i++) v = smoothToward(v, 1, 1 / fps, 0.2)
      return v
    }
    expect(run(60)).toBeCloseTo(run(30), 9)
    expect(run(144)).toBeCloseTo(run(30), 9)
    // Two half steps are one whole step.
    const half = smoothToward(smoothToward(0.2, 0.8, 0.01), 0.8, 0.01)
    expect(half).toBeCloseTo(smoothToward(0.2, 0.8, 0.02), 12)
  })

  it("stays put with no time", () => {
    expect(smoothToward(0.3, 1, 0)).toBe(0.3)
  })
})

describe("easeInOutCubic", () => {
  it("runs 0 to 1, symmetric about the middle", () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5)
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1)
  })
})

describe("the explode store", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    })
  })
  afterEach(() => vi.useRealTimers())

  it("sets, clamps and tells its subscribers", () => {
    const s = createExplodeStore()
    const fn = vi.fn()
    s.subscribe(fn)
    s.set(0.4)
    s.set(0.4)
    expect(fn).toHaveBeenCalledTimes(1)
    s.set(3)
    expect(s.get()).toBe(1)
  })

  it("tweens to a value over the time asked, eased", () => {
    const s = createExplodeStore(1)
    const done = vi.fn()
    s.animateTo(0, 4000, done)
    expect(s.animating()).toBe(0)
    vi.advanceTimersByTime(1000)
    // A quarter of the way in time, an eased eighth of the way in value.
    expect(s.get()).toBeGreaterThan(0.9)
    vi.advanceTimersByTime(1000)
    expect(s.get()).toBeCloseTo(0.5, 1)
    vi.advanceTimersByTime(2100)
    expect(s.get()).toBe(0)
    expect(s.animating()).toBeNull()
    expect(done).toHaveBeenCalledOnce()
  })

  it("stops a tween when the slider moves", () => {
    const s = createExplodeStore(1)
    s.animateTo(0, 4000)
    vi.advanceTimersByTime(500)
    s.set(0.7)
    vi.advanceTimersByTime(4000)
    expect(s.get()).toBe(0.7)
    expect(s.animating()).toBeNull()
  })

  it("sends the next press the other way", () => {
    const s = createExplodeStore(1)
    expect(nextAnimateTarget(s)).toBe(0)
    s.set(0)
    expect(nextAnimateTarget(s)).toBe(1)
    s.animateTo(1, 4000)
    // Pressed again mid-way: back down.
    expect(nextAnimateTarget(s)).toBe(0)
  })
})
