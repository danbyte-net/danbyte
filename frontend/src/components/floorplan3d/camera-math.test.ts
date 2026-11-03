import { describe, expect, it } from "vitest"

import { gridStep } from "./room"
import {
  NAV_KEYS,
  PAGE_SCROLL_KEYS,
  dollyThroughStep,
  nearForDistance,
  normalizeKey,
  panVector,
  pullInTarget,
  MAX_POLAR,
  MIN_ZOOM_STEP_M,
  advanceFly,
  flyDuration,
  frameBox,
  orbitAround,
  panOffset,
  panPlaneNormal,
  rayPlane,
  targetAtDepth,
  viewDirection,
  wheelNotches,
  zoomTowards,
} from "./camera-math"
import type { Vec3 } from "./camera-math"

const dist3 = (a: Vec3, b: Vec3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const unit3 = (a: Vec3): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2])
  return [a[0] / l, a[1] / l, a[2] / l]
}

describe("wheelNotches", () => {
  it("one mouse tick is one notch, in is negative", () => {
    expect(wheelNotches(-100, 0)).toBeCloseTo(-1)
    expect(wheelNotches(100, 0)).toBeCloseTo(1)
    expect(wheelNotches(-3, 1)).toBeCloseTo(-0.99)
  })
  it("trackpad pixels glide, pinch doubles, a burst is clamped", () => {
    expect(wheelNotches(-4, 0)).toBeCloseTo(-0.04)
    expect(wheelNotches(-4, 0, true)).toBeCloseTo(-0.08)
    expect(wheelNotches(-5000, 0)).toBe(-4)
  })
})

describe("zoomTowards - zoom to the point under the cursor", () => {
  const opts = { minGap: 0.05, maxDist: 5000 }

  it("covers the same share of the distance at any scale", () => {
    for (const d of [2, 200, 2000]) {
      const next = zoomTowards([0, d, 0], [0, 0, 0], -1, opts)
      expect(next[1] / d).toBeCloseTo(0.8)
    }
  })

  it("moves along the cursor ray, so the anchor stays under it", () => {
    const cam: Vec3 = [10, 20, 30]
    const anchor: Vec3 = [-40, 0, 5]
    const next = zoomTowards(cam, anchor, -2, opts)
    const before = unit3([
      anchor[0] - cam[0],
      anchor[1] - cam[1],
      anchor[2] - cam[2],
    ])
    const after = unit3([
      anchor[0] - next[0],
      anchor[1] - next[1],
      anchor[2] - next[2],
    ])
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i])
  })

  it("never crawls: close in, a notch still moves the minimum step", () => {
    const next = zoomTowards([0, 0.2, 0], [0, 0, 0], -0.1, opts)
    expect(0.2 - next[1]).toBeCloseTo(MIN_ZOOM_STEP_M * 0.1)
  })

  it("never crosses the surface: it stops minGap short of the anchor", () => {
    let cam: Vec3 = [0, 3, 0]
    for (let i = 0; i < 200; i++) cam = zoomTowards(cam, [0, 0, 0], -4, opts)
    expect(cam[1]).toBeCloseTo(0.05)
    expect(cam[1]).toBeGreaterThan(0)
    // At the stop, a further notch does nothing.
    expect(zoomTowards(cam, [0, 0, 0], -1, opts)).toEqual(cam)
  })

  it("zooms out as the inverse, capped at maxDist from the anchor", () => {
    const out = zoomTowards([0, 8, 0], [0, 0, 0], 1, opts)
    expect(out[1]).toBeCloseTo(10)
    const capped = zoomTowards([0, 4900, 0], [0, 0, 0], 4, opts)
    expect(capped[1]).toBeCloseTo(5000)
  })
})

describe("targetAtDepth", () => {
  it("puts the target on the sight line at the anchor's depth", () => {
    const t = targetAtDepth([0, 10, 0], [0, -1, 0], [3, 0, 4], 0.05)
    expect(t).toEqual([0, 0, 0])
  })
  it("never behind or on the camera", () => {
    const t = targetAtDepth([0, 10, 0], [0, -1, 0], [0, 20, 0], 0.5)
    expect(t[1]).toBeCloseTo(9.5)
  })
})

describe("orbitAround - orbit about the point under the cursor", () => {
  const cam: Vec3 = [0, 5, 10]
  const target: Vec3 = [0, 1, 0]
  const pivot: Vec3 = [4, 0, -2]

  it("keeps the camera's distance to the pivot", () => {
    const r = orbitAround(cam, target, pivot, 0.7, -0.3)
    expect(dist3(r.cam, pivot)).toBeCloseTo(dist3(cam, pivot))
    expect(dist3(r.target, pivot)).toBeCloseTo(dist3(target, pivot))
  })

  it("is rigid: the camera still looks at its target from as far", () => {
    const r = orbitAround(cam, target, pivot, -1.2, 0.2)
    expect(dist3(r.cam, r.target)).toBeCloseTo(dist3(cam, target))
  })

  it("yaw alone keeps the height", () => {
    const r = orbitAround(cam, target, pivot, 1, 0)
    expect(r.cam[1]).toBeCloseTo(cam[1])
  })

  it("clamps the tilt: never past overhead or straight up", () => {
    const over = orbitAround(cam, target, target, 0, -10)
    const f = unit3([
      over.target[0] - over.cam[0],
      over.target[1] - over.cam[1],
      over.target[2] - over.cam[2],
    ])
    expect(f[1]).toBeGreaterThan(-1)
    expect(f[1]).toBeLessThan(-0.99)
    const under = orbitAround(cam, target, target, 0, 10)
    const g = unit3([
      under.target[0] - under.cam[0],
      under.target[1] - under.cam[1],
      under.target[2] - under.cam[2],
    ])
    expect(Math.acos(-g[1])).toBeCloseTo(MAX_POLAR)
  })
})

describe("panOffset - grab-pan", () => {
  it("puts the grabbed point back under the cursor", () => {
    const cam0: Vec3 = [0, 20, 20]
    const grab: Vec3 = [3, 0, -1]
    const normal = panPlaneNormal(unit3([0, -20, -20]))
    expect(normal).toEqual([0, 1, 0])
    // The cursor has moved: the ray through it now points elsewhere.
    const dir = unit3([5, -20, -25])
    const off = panOffset(cam0, dir, grab, normal, 1000)!
    const cam = [cam0[0] + off[0], cam0[1] + off[1], cam0[2] + off[2]] as const
    // From the moved camera, the same pixel's ray runs through the grab.
    const t = rayPlane(cam, dir, grab, normal)!
    const hit = [cam[0] + dir[0] * t, cam[1] + dir[1] * t, cam[2] + dir[2] * t]
    for (let i = 0; i < 3; i++) expect(hit[i]).toBeCloseTo(grab[i])
    // A level plane keeps the camera's height.
    expect(off[1]).toBeCloseTo(0)
  })

  it("moves further for a far grab than a near one - speed follows distance", () => {
    const n: Vec3 = [0, 1, 0]
    const dir = unit3([0.1, -1, -0.1])
    const near = panOffset([0, 2, 0], dir, [0, 0, 0], n, 1e6)!
    const far = panOffset([0, 200, 0], dir, [0, 0, 0], n, 1e6)!
    expect(Math.abs(far[0])).toBeCloseTo(Math.abs(near[0]) * 100)
  })

  it("faces the camera when the view is level, and misses parallel rays", () => {
    expect(panPlaneNormal([0, 0, -1])).toEqual([-0, -0, 1])
    expect(panOffset([0, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0], 10)).toBeNull()
  })
})

describe("frameBox - framing a box from an angle", () => {
  const fov = (45 * Math.PI) / 180
  const aspect = 16 / 9

  it("centres the target and keeps every corner inside the frustum", () => {
    const min: Vec3 = [10, 0, 20]
    const max: Vec3 = [40, 2.5, 35]
    const dir = viewDirection([0.6, -0.5, -0.6], 0.6)
    const { target, position } = frameBox(min, max, dir, fov, aspect)
    expect(target).toEqual([25, 1.25, 27.5])
    const f = unit3([
      target[0] - position[0],
      target[1] - position[1],
      target[2] - position[2],
    ])
    const r = unit3([-f[2], 0, f[0]])
    const u = [
      r[1] * f[2] - r[2] * f[1],
      r[2] * f[0] - r[0] * f[2],
      r[0] * f[1] - r[1] * f[0],
    ]
    const tanY = Math.tan(fov / 2)
    for (let i = 0; i < 8; i++) {
      const c = [
        i & 1 ? max[0] : min[0],
        i & 2 ? max[1] : min[1],
        i & 4 ? max[2] : min[2],
      ]
      const v = [c[0] - position[0], c[1] - position[1], c[2] - position[2]]
      const z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2]
      const x = v[0] * r[0] + v[1] * r[1] + v[2] * r[2]
      const y = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]
      expect(z).toBeGreaterThan(0)
      expect(Math.abs(y) / z).toBeLessThanOrEqual(tanY + 1e-9)
      expect(Math.abs(x) / z).toBeLessThanOrEqual(tanY * aspect + 1e-9)
    }
  })

  it("comes in at the asked elevation, on the camera's heading", () => {
    const dir = viewDirection([1, -0.3, 0], 0.6)
    expect(dir[1]).toBeCloseTo(Math.sin(0.6))
    expect(dir[0]).toBeLessThan(0) // behind the object, as the camera was
    expect(dir[2]).toBeCloseTo(0)
    const { target, position } = frameBox(
      [0, 0, 0],
      [1, 1, 1],
      dir,
      fov,
      aspect
    )
    const back = unit3([
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2],
    ])
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(dir[i])
  })

  it("a bigger box stands further off; minDist is a floor", () => {
    const dir = viewDirection([0, -1, -1], 0.6)
    const small = frameBox([0, 0, 0], [1, 1, 1], dir, fov, aspect)
    const big = frameBox([0, 0, 0], [100, 1, 100], dir, fov, aspect)
    expect(dist3(big.position, big.target)).toBeGreaterThan(
      dist3(small.position, small.target) * 20
    )
    const floored = frameBox([0, 0, 0], [0.01, 0.01, 0.01], dir, fov, aspect, {
      minDist: 0.5,
    })
    expect(dist3(floored.position, floored.target)).toBeCloseTo(0.5)
  })

  it("looking straight down keeps a heading instead of collapsing", () => {
    const dir = viewDirection([0, -1, 0], 0.6)
    expect(Number.isFinite(dir[0] + dir[1] + dir[2])).toBe(true)
    expect(Math.hypot(...dir)).toBeCloseTo(1)
  })
})

describe("advanceFly - fly-to easing and reduced motion", () => {
  const base = {
    fromPos: [0, 10, 10] as Vec3,
    fromTarget: [0, 0, 0] as Vec3,
    toPos: [50, 3, 50] as Vec3,
    toTarget: [50, 1, 45] as Vec3,
    t: 0,
  }

  it("eases from start to end over its duration", () => {
    const fly = { ...base, duration: 0.8 }
    const first = advanceFly(fly, 0.016)
    expect(first.done).toBe(false)
    expect(dist3(first.pos, base.fromPos)).toBeLessThan(0.1)
    const mid = advanceFly({ ...fly, t: 0.4 }, 0)
    expect(mid.pos[0]).toBeCloseTo(25)
    const end = advanceFly({ ...fly, t: 0.79 }, 0.05)
    expect(end.done).toBe(true)
    expect(end.pos).toEqual([50, 3, 50])
    expect(end.target).toEqual([50, 1, 45])
  })

  it("a zero duration (reduced motion) lands in one frame", () => {
    const step = advanceFly({ ...base, duration: 0 }, 0.016)
    expect(step.done).toBe(true)
    expect(step.pos).toEqual([50, 3, 50])
    expect(step.target).toEqual([50, 1, 45])
  })

  it("longer hops take a little longer, within bounds", () => {
    expect(flyDuration(0)).toBeCloseTo(0.55)
    expect(flyDuration(10)).toBeGreaterThan(flyDuration(1))
    expect(flyDuration(1e6)).toBe(1.1)
  })
})

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

  it("moves vertically at ×0.6 - Space/PageUp rise, C/PageDown descend", () => {
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

describe("dollyThroughStep - the zoom wall becomes a walk", () => {
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

  it("is a pure translation - camera↔target distance is preserved", () => {
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
  it("clamps 1 cm – 25 m, scaling at 2% of the orbit distance", () => {
    expect(nearForDistance(0.05)).toBeCloseTo(0.01)
    expect(nearForDistance(10)).toBeCloseTo(0.2)
    // A site-sized plan seen from far keeps its floor layers apart.
    expect(nearForDistance(500)).toBeCloseTo(10)
    expect(nearForDistance(5000)).toBe(25)
  })

  it("stays under half the camera's height, so a low orbit keeps the floor", () => {
    // 400 m from the target but 4 m over a site-sized floor: 2 m, not 8.
    expect(nearForDistance(400, 4)).toBeCloseTo(2)
    expect(nearForDistance(400, -4)).toBeCloseTo(2)
    // High above, the distance rules as before.
    expect(nearForDistance(400, 300)).toBeCloseTo(8)
    expect(nearForDistance(400, 0)).toBeCloseTo(0.01)
  })
})

describe("gridStep", () => {
  it("draws every line up to 120 cells, then thins to about 120", () => {
    expect(gridStep(24, 16)).toBe(1)
    expect(gridStep(120, 80)).toBe(1)
    expect(gridStep(512, 266)).toBe(5)
  })
})
