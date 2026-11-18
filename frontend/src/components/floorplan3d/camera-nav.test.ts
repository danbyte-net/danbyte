import { describe, expect, it } from "vitest"

import { zoomTowards } from "./camera-math"
import {
  FLOOR_MAX_POLAR,
  MARKER_FADE_IN,
  MARKER_FADE_OUT,
  MARKER_HOLD,
  MODEL_MAX_POLAR,
  adaptiveFar,
  adaptiveNear,
  NEAR_FAR_RATIO,
  classifyWheel,
  clickPivot,
  easeShare,
  inView,
  markerOpacity,
  orbitLimited,
  orthoZoomAt,
  orthoZoomFactor,
  polarOf,
  screenPan,
  worldPerPixel,
} from "./camera-nav"
import type { Vec3 } from "./camera-math"

const sub = (a: Vec3, b: Vec3): [number, number, number] => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
]
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2])
const unit = (a: readonly number[]) => a.map((v) => v / len(a))

describe("clickPivot - a click sets the pivot without moving the view", () => {
  const cam: Vec3 = [0, 2, 10]
  const fwd: Vec3 = [0, 0, -1]

  it("pivots on the hit, the target on the sight line at its depth", () => {
    const r = clickPivot(cam, fwd, [1.5, 0.5, 4], 0.05)
    expect(r.pivot).toEqual([1.5, 0.5, 4])
    expect(r.target[0]).toBeCloseTo(0)
    expect(r.target[1]).toBeCloseTo(2)
    expect(r.target[2]).toBeCloseTo(4)
  })

  it("keeps the view direction: camera to target is still forward", () => {
    const r = clickPivot(cam, fwd, [-3, 1, -2], 0.05)
    const dir = unit(sub(r.target, cam))
    expect(dir[0]).toBeCloseTo(0)
    expect(dir[1]).toBeCloseTo(0)
    expect(dir[2]).toBeCloseTo(-1)
  })

  it("never puts the target behind the camera", () => {
    const r = clickPivot(cam, fwd, [0, 2, 12], 0.05)
    expect(r.target[2]).toBeCloseTo(9.95)
  })
})

describe("inView", () => {
  it("is on screen inside the NDC cube only", () => {
    expect(inView([0, 0, 0.5])).toBe(true)
    expect(inView([1.2, 0, 0.5])).toBe(false)
    expect(inView([0, 0, 1.5])).toBe(false)
  })
})

describe("orbitLimited - level horizon, never under the floor", () => {
  const pivot: Vec3 = [0, 1, 0]
  const cam: Vec3 = [0, 3, 5]
  const target: Vec3 = [0, 1, 0]

  it("keeps the distance to the pivot and turns freely in yaw", () => {
    const r = orbitLimited(cam, target, pivot, 0.7, 0, {
      maxPolar: FLOOR_MAX_POLAR,
    })
    expect(len(sub(r.cam, pivot))).toBeCloseTo(len(sub(cam, pivot)))
    expect(r.cam[1]).toBeCloseTo(3)
  })

  it("stops a tilt at the pivot's horizon (85°), not past it", () => {
    const r = orbitLimited(cam, target, pivot, 0, 2, {
      maxPolar: FLOOR_MAX_POLAR,
    })
    const p = polarOf(sub(r.cam, pivot))
    expect(p).toBeLessThanOrEqual(FLOOR_MAX_POLAR + 1e-6)
    expect(p).toBeGreaterThan(FLOOR_MAX_POLAR - 0.01)
    expect(r.cam[1]).toBeGreaterThan(pivot[1])
  })

  it("a lone model may be seen from below", () => {
    const r = orbitLimited(cam, target, pivot, 0, 2, {
      maxPolar: MODEL_MAX_POLAR,
    })
    expect(r.cam[1]).toBeLessThan(pivot[1])
  })

  it("a camera already past the limit may tilt back, never further", () => {
    const low: Vec3 = [0, 0.8, 5]
    const back = orbitLimited(low, target, pivot, 0, -0.3, {
      maxPolar: FLOOR_MAX_POLAR,
    })
    expect(back.cam[1]).toBeGreaterThan(0.8)
    const worse = orbitLimited(low, target, pivot, 0, 0.3, {
      maxPolar: FLOOR_MAX_POLAR,
    })
    expect(worse.cam[1]).toBeCloseTo(0.8)
  })

  it("keeps the camera above minY", () => {
    const r = orbitLimited([0, 3, 5], target, [0, 0, 0], 0, 3, {
      maxPolar: MODEL_MAX_POLAR,
      minY: 0.1,
    })
    expect(r.cam[1]).toBeGreaterThanOrEqual(0.1 - 1e-6)
  })

  it("never flips over the top", () => {
    const r = orbitLimited(cam, target, pivot, 0, -5, {
      maxPolar: FLOOR_MAX_POLAR,
    })
    // Still looking down at the target, not upside down.
    expect(r.target[1]).toBeLessThan(r.cam[1])
  })
})

describe("screen-plane pan keeps the grabbed point under the cursor", () => {
  const fovY = Math.PI / 4
  const h = 800

  it("one pixel at depth d covers 2·d·tan(fov/2)/h", () => {
    const k = worldPerPixel({ kind: "perspective", fovY, depth: 10 }, h)
    expect(k).toBeCloseTo((2 * 10 * Math.tan(fovY / 2)) / h)
  })

  it("is twice as fast at twice the depth", () => {
    const a = worldPerPixel({ kind: "perspective", fovY, depth: 5 }, h)
    const b = worldPerPixel({ kind: "perspective", fovY, depth: 10 }, h)
    expect(b).toBeCloseTo(a * 2)
  })

  it("orthographic: the view's height over the zoom", () => {
    expect(
      worldPerPixel({ kind: "orthographic", viewHeight: 800, zoom: 400 }, 800)
    ).toBeCloseTo(1 / 400)
  })

  it("slides along the screen axes only - dragging right moves the camera left", () => {
    const off = screenPan(10, 0, 0.01, [1, 0, 0], [0, 1, 0])
    expect(off).toEqual([-0.1, 0, 0])
    const down = screenPan(0, 10, 0.01, [1, 0, 0], [0, 1, 0])
    expect(down[1]).toBeCloseTo(0.1)
  })

  it("the grabbed point projects back to the cursor", () => {
    // Camera at origin looking −z; grab a point 10 m out, drag 100 px right.
    const depth = 10
    const k = worldPerPixel({ kind: "perspective", fovY, depth }, h)
    const grab: Vec3 = [0, 0, -depth]
    const off = screenPan(100, 0, k, [1, 0, 0], [0, 1, 0])
    // The grab seen from the moved camera: its screen x in pixels.
    const rel = sub(grab, off)
    const px = (rel[0] / (-rel[2] * Math.tan(fovY / 2))) * (h / 2)
    expect(px).toBeCloseTo(100)
  })
})

describe("classifyWheel - trackpad swipe pans, pinch and wheel zoom", () => {
  const ev = (o: Partial<Parameters<typeof classifyWheel>[0]>) => ({
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    ...o,
  })

  it("a pinch (ctrlKey) always zooms", () => {
    expect(classifyWheel(ev({ ctrlKey: true, deltaX: 4 }), "pan")).toBe("zoom")
  })

  it("a sideways swipe pans; a straight mouse wheel zooms", () => {
    expect(classifyWheel(ev({ deltaX: 3, deltaY: 2 }), null)).toBe("pan")
    expect(classifyWheel(ev({ deltaY: 100 }), null)).toBe("zoom")
    expect(classifyWheel(ev({ deltaY: 3, deltaMode: 1 }), null)).toBe("zoom")
  })

  it("a burst keeps what it started as", () => {
    expect(classifyWheel(ev({ deltaY: 5 }), "pan")).toBe("pan")
  })
})

describe("zoom has no distance limit", () => {
  it("zooms out without a cap", () => {
    const out = zoomTowards([0, 1e6, 0], [0, 0, 0], 4, {
      minGap: 0.05,
      maxDist: Infinity,
    })
    expect(out[1]).toBeGreaterThan(2e6)
  })

  it("but never passes the surface under the cursor", () => {
    const inn = zoomTowards([0, 0.06, 0], [0, 0, 0], -4, {
      minGap: 0.05,
      maxDist: Infinity,
    })
    expect(inn[1]).toBeCloseTo(0.05)
  })
})

describe("orthoZoomAt - zoom about the cursor", () => {
  it("scales the zoom by the notch factor", () => {
    expect(orthoZoomFactor(-1)).toBeCloseTo(1.25)
    expect(orthoZoomFactor(1)).toBeCloseTo(0.8)
  })

  it("keeps the world point under the cursor in place", () => {
    const halfW = 400
    const halfH = 300
    const ndc: [number, number] = [0.5, -0.25]
    const zoom = 100
    const r = orthoZoomAt(ndc, halfW, halfH, zoom, 2, [1, 0, 0], [0, 1, 0])
    expect(r.zoom).toBe(200)
    // World x under the cursor, relative to the camera, before and after.
    const before = (ndc[0] * halfW) / zoom
    const after = r.shift[0] + (ndc[0] * halfW) / r.zoom
    expect(after).toBeCloseTo(before)
    const beforeY = (ndc[1] * halfH) / zoom
    expect(r.shift[1] + (ndc[1] * halfH) / r.zoom).toBeCloseTo(beforeY)
  })

  it("the centre of the view does not move", () => {
    const r = orthoZoomAt([0, 0], 400, 300, 50, 3, [1, 0, 0], [0, 1, 0])
    expect(r.shift.map(Math.abs)).toEqual([0, 0, 0])
  })
})

describe("easeShare - damping, and none under reduced motion", () => {
  it("lands at once under reduced motion", () => {
    expect(easeShare(0.016, true)).toBe(1)
  })

  it("covers most of the way within a few frames, never overshoots", () => {
    const k = easeShare(1 / 60, false)
    expect(k).toBeGreaterThan(0.2)
    expect(k).toBeLessThan(1)
    expect(easeShare(0, false)).toBe(0)
    expect(easeShare(1, false)).toBeLessThanOrEqual(1)
  })
})

describe("markerOpacity", () => {
  it("fades in over 0.6 s, holds, fades out", () => {
    expect(MARKER_FADE_IN).toBeCloseTo(0.6)
    expect(markerOpacity(0, false)).toBe(0)
    expect(markerOpacity(0.3, false)).toBeCloseTo(0.5)
    expect(markerOpacity(MARKER_FADE_IN + 0.1, false)).toBe(1)
    const end = MARKER_FADE_IN + MARKER_HOLD + MARKER_FADE_OUT
    expect(markerOpacity(end + 0.01, false)).toBe(0)
  })

  it("does not fade under reduced motion", () => {
    expect(markerOpacity(0, true)).toBe(1)
    expect(markerOpacity(MARKER_FADE_IN + MARKER_HOLD + 0.01, true)).toBe(0)
  })

  it("is full while an orbit holds it", () => {
    expect(markerOpacity(99, false, true)).toBe(1)
  })
})

describe("adaptiveNear - the near plane stays in front of what is near", () => {
  it("scales with the target distance when nothing is closer, in steps", () => {
    // 2% of 10 m is 0.2 m: the power of two under it.
    expect(adaptiveNear({ toTarget: 10 })).toBe(0.125)
    expect(adaptiveNear({ toTarget: 11 })).toBe(0.125)
  })

  // The sliced doors: the camera beside a cabinet, the target 20 m off. A
  // near plane from the target alone (0.4 m) cut the door 30 cm away.
  it("never reaches past a surface nearer than the target", () => {
    const fromTargetOnly = adaptiveNear({ toTarget: 20 })
    expect(fromTargetOnly).toBeGreaterThan(0.2)
    const near = adaptiveNear({ toTarget: 20, toSurface: 0.3 })
    expect(near).toBeLessThan(0.3)
    expect(near).toBe(0.125)
  })

  it("stays under half the camera's height over the floor", () => {
    expect(adaptiveNear({ toTarget: 500, height: 2 })).toBe(1)
  })

  // The flicker: a near plane of millimetres against a far of hundreds of
  // metres left floor zones and door infill fighting for depth.
  it("keeps a floor of its own and of the far plane", () => {
    expect(adaptiveNear({ toTarget: 0, toSurface: 0 })).toBe(0.05)
    expect(adaptiveNear({ toTarget: 0, min: 0.0005 })).toBe(0.0005)
    expect(adaptiveNear({ toTarget: 1, toSurface: 0.01, far: 2000 })).toBe(0.1)
    expect(
      2000 / adaptiveNear({ toTarget: 3, toSurface: 0, far: 2000 })
    ).toBeLessThanOrEqual(NEAR_FAR_RATIO)
  })
})

describe("adaptiveFar - a zoom-out with no limit keeps the scene drawn", () => {
  it("keeps the scene's far while it covers the view", () => {
    expect(adaptiveFar(10, 500)).toBe(500)
  })

  it("grows past it when the camera backs off further", () => {
    expect(adaptiveFar(1e5, 500)).toBe(2e6)
  })
})
