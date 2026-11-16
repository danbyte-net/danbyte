import { describe, expect, it } from "vitest"

import {
  CORD_STUB_M,
  CordEndStore,
  cordLead,
  cross,
  dot,
  len,
  roundCorners,
  runCable,
  tightestBend,
  transportFrames,
  zipcordRails,
} from "./cord-run"
import type { CordEnd, Vec3 } from "./cord-run"

const ZIP = {
  profile: "zipcord" as const,
  jacket_mm: 1.8,
  pitch_mm: 1.84,
  min_bend_mm: 30,
}

const end = (at: Vec3, over: Partial<CordEnd> = {}): CordEnd => ({
  at,
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
  scale: 1,
  cable: ZIP,
  ...over,
})

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** A sampled helix-free 3D route: out along +Z, up, then across in X. */
const route: Vec3[] = []
for (let i = 0; i <= 20; i++) route.push([0, 0, i * 0.01])
for (let i = 1; i <= 20; i++) route.push([0, i * 0.02, 0.2])
for (let i = 1; i <= 20; i++) route.push([i * 0.02, 0.4, 0.2])

describe("rounding a route's corners", () => {
  it("bends no tighter than the minimum where the segments leave room", () => {
    const pts = roundCorners(
      [
        [0, 0, 0],
        [0, 0, 0.5],
        [0.5, 0, 0.5],
      ],
      0.1
    )
    expect(pts[0]).toEqual([0, 0, 0])
    expect(pts[pts.length - 1]).toEqual([0.5, 0, 0.5])
    expect(tightestBend(pts)).toBeGreaterThan(0.1 - 1e-6)
    expect(tightestBend(pts)).toBeLessThan(0.1 + 1e-6)
    // The arc meets both legs a radius from the corner (a 90° turn).
    expect(pts[1][2]).toBeCloseTo(0.4)
    expect(pts[pts.length - 2][0]).toBeCloseTo(0.1)
  })

  it("keeps a wider base fillet, and bends tighter only when cramped", () => {
    const wide = roundCorners(
      [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 1],
      ],
      0.03,
      0.12
    )
    expect(tightestBend(wide)).toBeCloseTo(0.12, 5)
    // Two adjacent ports: 2 cm free legs leave room for 2 cm at most, and
    // a 1 cm leg shared by two corners for half a centimetre each.
    const tight = roundCorners(
      [
        [0, 0, 0],
        [0, 0, 0.02],
        [0.02, 0, 0.02],
      ],
      0.03
    )
    expect(tightestBend(tight)).toBeCloseTo(0.02, 5)
    const shared = roundCorners(
      [
        [0, 0, 0],
        [0, 0, 0.05],
        [0.01, 0, 0.05],
        [0.01, 0, 0],
      ],
      0.03
    )
    expect(tightestBend(shared)).toBeCloseTo(0.005, 5)
    expect(tight.length).toBeGreaterThan(3)
  })

  it("leaves straight runs alone", () => {
    expect(
      roundCorners(
        [
          [0, 0, 0],
          [0, 0, 1],
          [0, 0, 2],
        ],
        0.03
      )
    ).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [0, 0, 2],
    ])
  })
})

describe("a zip cord's frame", () => {
  it("keeps up square and never turns about the run", () => {
    const frames = transportFrames(route, [0, 1, 0])
    expect(frames).toHaveLength(route.length)
    frames.forEach((f) => {
      expect(Math.abs(dot(f.n, f.t))).toBeLessThan(1e-9)
      expect(len(f.n)).toBeCloseTo(1)
      expect(len(f.x)).toBeCloseTo(1)
    })
    // Parallel transport: from one frame to the next the up vector does
    // not move sideways (no component along x) - no twist.
    for (let i = 1; i < frames.length; i++) {
      const dn = sub(frames[i].n, frames[i - 1].n)
      expect(Math.abs(dot(dn, frames[i - 1].x))).toBeLessThan(1e-6)
    }
    // Seeded from the cable empty: +Y up at the start, so the jackets lie
    // along ±X there.
    expect(frames[0].n).toEqual([0, 1, 0])
    expect(frames[0].x[0]).toBeCloseTo(1)
  })

  it("stays flat round a turn in the plane it lies in", () => {
    const flat: Vec3[] = [
      [0, 0, 0],
      [0, 0, 0.1],
      [0.05, 0, 0.15],
      [0.1, 0, 0.2],
      [0.3, 0, 0.2],
    ]
    for (const f of transportFrames(flat, [0, 1, 0])) {
      expect(f.n[1]).toBeCloseTo(1)
    }
  })

  it("turns evenly to meet the far end's up, by the smaller turn", () => {
    const straight: Vec3[] = [0, 1, 2, 3, 4].map((i) => [0, 0, i * 0.1])
    const s = Math.SQRT1_2
    const frames = transportFrames(straight, [0, 1, 0], [s, s, 0])
    const angle = (i: number) =>
      Math.atan2(dot(cross([0, 1, 0], frames[i].n), [0, 0, 1]), frames[i].n[1])
    expect(angle(0)).toBeCloseTo(0)
    expect(Math.abs(angle(4))).toBeCloseTo(Math.PI / 4)
    expect(Math.abs(angle(2))).toBeCloseTo(Math.PI / 8)
    // Upside down is the same zip cord: no half turn.
    const flip = transportFrames(straight, [0, 1, 0], [0, -1, 0])
    expect(flip[4].n[1]).toBeCloseTo(1)
  })

  it("lays two rails a pitch apart", () => {
    const frames = transportFrames(route, [0, 1, 0])
    const [l, r] = zipcordRails(route, frames, 0.00184)
    l.forEach((p, i) => expect(len(sub(p, r[i]))).toBeCloseTo(0.00184))
    expect(l[0][0]).toBeCloseTo(0.00092)
  })
})

describe("cord ends", () => {
  it("lead out of the cable empty along its +Z", () => {
    const [a, b] = cordLead(end([1, 2, 3], { z: [0, 0, -1] }))
    expect(a).toEqual([1, 2, 3])
    expect(b[2]).toBeCloseTo(3 - CORD_STUB_M)
  })

  it("take the A end's cable block first", () => {
    const round = { ...ZIP, profile: "round" as const }
    expect(
      runCable(end([0, 0, 0]), end([0, 0, 0], { cable: round }))!.cable
    ).toBe(ZIP)
    expect(runCable(null, end([0, 0, 0], { cable: round }))!.cable).toBe(round)
    expect(runCable(end([0, 0, 0], { cable: null }), null)).toBeNull()
  })

  it("store by device and port, and only tell of real changes", () => {
    const store = new CordEndStore()
    let calls = 0
    const off = store.subscribe(() => calls++)
    store.setDevice("d1", new Map([["Te1/0/1", end([0, 0, 0])]]))
    expect(store.get("d1", "Te1/0/1")?.at).toEqual([0, 0, 0])
    expect(store.get("d1", "Te1/0/2")).toBeNull()
    store.setDevice("d1", new Map([["Te1/0/1", end([0, 0, 1e-9])]]))
    store.setDevice("d2", new Map())
    expect(calls).toBe(1)
    store.setDevice("d1", null)
    expect(calls).toBe(2)
    expect(store.get("d1", "Te1/0/1")).toBeNull()
    expect(store.getVersion()).toBe(2)
    off()
  })
})
