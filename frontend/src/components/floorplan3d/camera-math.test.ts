import { describe, expect, it } from "vitest"

import {
  NAV_KEYS,
  PAGE_SCROLL_KEYS,
  dollyThroughStep,
  nearForDistance,
  normalizeKey,
  panVector,
  pullInTarget,
  zoomSpeedForRoom,
} from "./camera-math"

// Camera looking toward -z (the three.js default view direction).
const FWD: [number, number] = [0, -1]
// Distance 10 m → 10 × 0.9 = 9 m/s, inside the 1.5–40 clamp window.
const DIST = 10

const keys = (...ks: string[]) => new Set(ks)

const length = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2])

describe("normalizeKey", () => {
  it("lowercases single characters, keeps named keys", () => {
    expect(normalizeKey("W")).toBe("w")
    expect(normalizeKey("w")).toBe("w")
    expect(normalizeKey("ArrowUp")).toBe("ArrowUp")
    expect(normalizeKey("PageDown")).toBe("PageDown")
  })
})

describe("key sets", () => {
  it("covers all thirteen nav keys; scroll keys are a subset", () => {
    expect(NAV_KEYS.size).toBe(13)
    expect(NAV_KEYS.has("c")).toBe(true)
    for (const k of PAGE_SCROLL_KEYS) expect(NAV_KEYS.has(k)).toBe(true)
    expect(PAGE_SCROLL_KEYS.has("w")).toBe(false)
    expect(PAGE_SCROLL_KEYS.has("c")).toBe(false)
    expect(PAGE_SCROLL_KEYS.has("Shift")).toBe(false)
    expect(PAGE_SCROLL_KEYS.has("Escape")).toBe(false)
  })
})

describe("panVector", () => {
  it("returns zero for an empty set or non-nav keys", () => {
    expect(panVector(keys(), FWD, DIST, 1)).toEqual([0, 0, 0])
    expect(panVector(keys("x", "Escape"), FWD, DIST, 1)).toEqual([0, 0, 0])
  })

  it("moves along the forward vector", () => {
    const [dx, dy, dz] = panVector(keys("w"), FWD, DIST, 1)
    expect(dx).toBeCloseTo(0)
    expect(dy).toBe(0)
    expect(dz).toBeCloseTo(-9)
    // A rotated camera pans along its own forward, not a fixed axis.
    const [rx, , rz] = panVector(keys("w"), [1, 0], DIST, 1)
    expect(rx).toBeCloseTo(9)
    expect(rz).toBeCloseTo(0)
  })

  it("treats arrows and letters as the same axis, without doubling", () => {
    const arrow = panVector(keys("ArrowUp"), FWD, DIST, 1)
    const letter = panVector(keys("w"), FWD, DIST, 1)
    const both = panVector(keys("ArrowUp", "w"), FWD, DIST, 1)
    expect(arrow).toEqual(letter)
    expect(both).toEqual(letter)
  })

  it("strafes perpendicular to forward", () => {
    expect(panVector(keys("s"), FWD, DIST, 1)[2]).toBeCloseTo(9)
    expect(panVector(keys("d"), FWD, DIST, 1)[0]).toBeCloseTo(9)
    expect(panVector(keys("a"), FWD, DIST, 1)[0]).toBeCloseTo(-9)
    // Facing +x, "right" is +z.
    expect(panVector(keys("d"), [1, 0], DIST, 1)[2]).toBeCloseTo(9)
  })

  it("normalizes diagonals so two keys are not faster than one", () => {
    const v = panVector(keys("w", "d"), FWD, DIST, 1)
    expect(length(v)).toBeCloseTo(9)
    expect(v[0]).toBeCloseTo(9 / Math.SQRT2)
    expect(v[2]).toBeCloseTo(-9 / Math.SQRT2)
  })

  it("cancels opposing keys but keeps the remaining axis", () => {
    expect(panVector(keys("w", "s"), FWD, DIST, 1)).toEqual([0, 0, 0])
    const [dx, dy, dz] = panVector(keys("w", "s", " "), FWD, DIST, 1)
    expect(dx).toBe(0)
    expect(dz).toBe(0)
    expect(dy).toBeCloseTo(9 * 0.6)
  })

  it("scales speed with distance, clamped to 1.5–40 m/s", () => {
    // 1 m → 0.9 m/s, clamped up to the 1.5 floor.
    expect(panVector(keys("w"), FWD, 1, 1)[2]).toBeCloseTo(-1.5)
    // 100 m → 90 m/s, clamped down to the 40 ceiling.
    expect(panVector(keys("w"), FWD, 100, 1)[2]).toBeCloseTo(-40)
    // In between it is linear at ×0.9.
    expect(panVector(keys("w"), FWD, 20, 1)[2]).toBeCloseTo(-18)
  })

  it("moves vertically at ×0.6 — Space/PageUp rise, C/PageDown descend", () => {
    expect(panVector(keys(" "), FWD, DIST, 1)[1]).toBeCloseTo(5.4)
    expect(panVector(keys("PageUp"), FWD, DIST, 1)[1]).toBeCloseTo(5.4)
    expect(panVector(keys("c"), FWD, DIST, 1)[1]).toBeCloseTo(-5.4)
    expect(panVector(keys("PageDown"), FWD, DIST, 1)[1]).toBeCloseTo(-5.4)
  })

  it("Shift sprints ×4 (horizontal and vertical) but moves nothing alone", () => {
    expect(panVector(keys("Shift"), FWD, DIST, 1)).toEqual([0, 0, 0])
    expect(panVector(keys("w", "Shift"), FWD, DIST, 1)[2]).toBeCloseTo(-36)
    expect(panVector(keys(" ", "Shift"), FWD, DIST, 1)[1]).toBeCloseTo(21.6)
  })

  it("sprint is capped at 80 m/s", () => {
    // 100 m → base clamps to 40; ×4 would be 160 → sprint ceiling 80.
    expect(panVector(keys("w", "Shift"), FWD, 100, 1)[2]).toBeCloseTo(-80)
  })

  it("scales linearly with dt", () => {
    const full = panVector(keys("w", " "), FWD, DIST, 1)
    const part = panVector(keys("w", " "), FWD, DIST, 0.25)
    expect(part[0]).toBeCloseTo(full[0] / 4)
    expect(part[1]).toBeCloseTo(full[1] / 4)
    expect(part[2]).toBeCloseTo(full[2] / 4)
  })

  it("suppresses horizontal motion on a degenerate forward, keeps vertical", () => {
    expect(panVector(keys("w", "d"), [0, 0], DIST, 1)).toEqual([0, 0, 0])
    expect(panVector(keys(" "), [0, 0], DIST, 1)[1]).toBeCloseTo(5.4)
  })
})

describe("pullInTarget", () => {
  it("pulls a far target to the pivot distance along the sight line", () => {
    const t = pullInTarget([0, 1.6, 0], [0, 1.6, 10], 3)
    expect(t).not.toBeNull()
    expect(t![0]).toBeCloseTo(0)
    expect(t![1]).toBeCloseTo(1.6)
    expect(t![2]).toBeCloseTo(3)
  })

  it("keeps the vertical component of the sight line", () => {
    const t = pullInTarget([0, 4, 0], [0, 0, 8], 3)!
    const d = Math.hypot(t[0] - 0, t[1] - 4, t[2] - 0)
    expect(d).toBeCloseTo(3)
    expect(t[1]).toBeLessThan(4) // still descending toward the old target
  })

  it("returns null when the target is already near (never zooms the view)", () => {
    expect(pullInTarget([0, 1, 0], [0, 1, 2], 3)).toBeNull()
    expect(pullInTarget([0, 1, 0], [0, 1, 3], 3)).toBeNull()
    expect(pullInTarget([1, 1, 1], [1, 1, 1], 3)).toBeNull() // degenerate
  })
})

describe("dollyThroughStep — the zoom wall becomes a walk", () => {
  // Camera 5 cm behind its target, looking toward −z: at the wall.
  const CAM = [0, 1, 5] as const
  const TGT = [0, 1, 4.95] as const

  it("ignores wheel-out, and wheel-in while still far from the wall", () => {
    expect(dollyThroughStep(CAM, TGT, 100, 0.05)).toBeNull()
    expect(dollyThroughStep(CAM, [0, 1, 0], -100, 5)).toBeNull()
  })

  it("walks the full step along the sight line at the wall", () => {
    const s = dollyThroughStep(CAM, TGT, -100, 0.05)!
    expect(s[0]).toBeCloseTo(0)
    expect(s[1]).toBeCloseTo(0)
    expect(s[2]).toBeCloseTo(-0.35)
  })

  it("scales pixel-mode trackpad deltas down, floored at 5%", () => {
    expect(dollyThroughStep(CAM, TGT, -10, 0.05)![2]).toBeCloseTo(-0.035)
    expect(dollyThroughStep(CAM, TGT, -1, 0.05)![2]).toBeCloseTo(-0.0175)
  })

  it("is a pure translation — camera↔target distance is preserved", () => {
    const s = dollyThroughStep(CAM, TGT, -100, 0.05)!
    const d = Math.hypot(
      TGT[0] + s[0] - (CAM[0] + s[0]),
      TGT[1] + s[1] - (CAM[1] + s[1]),
      TGT[2] + s[2] - (CAM[2] + s[2])
    )
    expect(d).toBeCloseTo(0.05)
  })

  it("returns null for a degenerate camera-on-target", () => {
    expect(dollyThroughStep([0, 1, 0], [0, 1, 0], -100, 0)).toBeNull()
  })
})

describe("nearForDistance", () => {
  it("clamps 1 cm – 0.5 m, scaling at 2% of the orbit distance", () => {
    expect(nearForDistance(0.05)).toBeCloseTo(0.01)
    expect(nearForDistance(10)).toBeCloseTo(0.2)
    expect(nearForDistance(1000)).toBeCloseTo(0.5)
  })
})

describe("zoomSpeedForRoom", () => {
  it("1 for closets, 2 for halls, linear between", () => {
    expect(zoomSpeedForRoom(6)).toBeCloseTo(1.05)
    expect(zoomSpeedForRoom(60)).toBeCloseTo(1.5)
    expect(zoomSpeedForRoom(500)).toBe(2)
  })
})
