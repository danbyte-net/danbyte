import { describe, expect, it } from "vitest"

import { MODEL_PORT_SELECTED, MODEL_PORT_UNDEFINED } from "./model-ports"
import { PORT_BOX_MM } from "./model-studio"
import {
  MODEL_PORT_RESERVED,
  acrossAxis,
  lighten,
  markerLook,
  markerShape,
  rimRoom,
  rimWidth,
  roundedRect,
  shapeKey,
} from "./port-marker-look"
import type { V3 } from "./port-marker-look"

const TIER = "#3b82f6"
const GREY = "#9ca3af"

describe("markerLook (quiet default)", () => {
  it("draws a free port not at all", () => {
    expect(markerLook({ id: "a", connected: false }, GREY)).toEqual({
      rim: null,
      fill: null,
    })
    expect(markerLook({ id: null }, TIER)).toEqual({ rim: null, fill: null })
    expect(markerLook({}, GREY)).toEqual({ rim: null, fill: null })
  })

  it("washes a cabled or marked port, no rim", () => {
    expect(markerLook({ id: "a", connected: true }, TIER)).toEqual({
      rim: null,
      fill: TIER,
    })
    expect(
      markerLook({ id: "a", connected: false, cable_state: "marked" }, TIER)
    ).toEqual({ rim: null, fill: TIER })
  })

  it("rims a held port in amber", () => {
    expect(
      markerLook({ id: "a", connected: false, cable_state: "reserved" }, TIER)
    ).toEqual({ rim: MODEL_PORT_RESERVED, fill: null })
  })

  it("shows a hovered free port: a lighter rim and a wash", () => {
    const hover = markerLook({ id: "a", connected: false }, GREY, "hover")
    expect(hover.rim).toBe(lighten(GREY, 0.45))
    expect(hover.fill).toBe(GREY)
  })

  it("takes the selection colour when selected, whatever the state", () => {
    for (const p of [
      { id: "a", connected: true },
      { id: "a", connected: false },
      { id: "a", connected: false, cable_state: "reserved" },
    ])
      expect(markerLook(p, TIER, "selected")).toEqual({
        rim: MODEL_PORT_SELECTED,
        fill: MODEL_PORT_SELECTED,
      })
  })
})

describe("markerLook (outline all)", () => {
  it("rims every port in its state colour", () => {
    expect(
      markerLook({ id: "a", connected: false }, GREY, "idle", true)
    ).toEqual({ rim: GREY, fill: null })
    expect(
      markerLook({ id: "a", connected: true }, TIER, "idle", true)
    ).toEqual({ rim: TIER, fill: TIER })
    expect(markerLook({ id: null }, TIER, "idle", true).rim).toBe(
      MODEL_PORT_UNDEFINED
    )
    expect(
      markerLook(
        { id: "a", connected: false, cable_state: "reserved" },
        TIER,
        "idle",
        true
      ).rim
    ).toBe(MODEL_PORT_RESERVED)
  })
})

const FRONT: V3 = [0, 0, -1]
const near = (a: V3, b: V3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]))

describe("markerShape", () => {
  // A 1U switch fitted at 0.44 m across: its longest edge.
  const size: V3 = [0.44, 0.044, 0.4]

  it("is the anchor's exact opening, scaled by the longest edge", () => {
    const s = markerShape(
      {
        n: FRONT,
        s: [0.0142 / 0.44, 0.0095 / 0.44],
        r: 0.0005 / 0.44,
        u: [-1, 0, 0],
      },
      size
    )
    expect(s.w).toBeCloseTo(0.0142)
    expect(s.h).toBeCloseTo(0.0095)
    expect(s.r).toBeCloseTo(0.0005)
    near(s.u, [-1, 0, 0])
    near(s.n, FRONT)
    // v = n × u: up the face.
    near(s.v, [0, 1, 0])
  })

  it("turns with the anchor: a port on its side stands tall", () => {
    const s = markerShape({ n: FRONT, s: [0.03, 0.02], u: [0, 1, 0] }, size)
    near(s.u, [0, 1, 0])
    near(s.v, [1, 0, 0])
  })

  it("falls back to the standard box for the port's type", () => {
    const s = markerShape(
      { n: FRONT, kind: "interface", type: "25gbase-x-sfp28" },
      size
    )
    expect(s.w).toBeCloseTo(PORT_BOX_MM.sfp[0] / 1000)
    expect(s.h).toBeCloseTo(PORT_BOX_MM.sfp[1] / 1000)
    expect(s.r).toBe(0)
    // Level on the face: width across, height up.
    expect(Math.abs(s.u[0])).toBeCloseTo(1)
    expect(Math.abs(s.v[1])).toBeCloseTo(1)
  })

  it("caps the radius at half the short side", () => {
    const s = markerShape({ n: FRONT, s: [0.02, 0.01], r: 0.05 }, [1, 1, 1])
    expect(s.r).toBeCloseTo(0.005)
  })
})

describe("acrossAxis", () => {
  it("keeps a given axis in the opening's plane", () => {
    near(acrossAxis(FRONT, [1, 0, 0.5]), [1, 0, 0])
  })

  it("is level without one, and on a port facing up", () => {
    near(acrossAxis([0, 0, 1]), [1, 0, 0])
    const up = acrossAxis([0, 1, 0])
    expect(Math.abs(up[1])).toBeCloseTo(0)
    expect(Math.hypot(...up)).toBeCloseTo(1)
  })
})

describe("geometry helpers", () => {
  it("draws a square-cornered box as four corners", () => {
    expect(roundedRect(2, 1, 0)).toEqual([
      [-1, -0.5],
      [1, -0.5],
      [1, 0.5],
      [-1, 0.5],
    ])
  })

  it("keeps a rounded box inside its size", () => {
    const pts = roundedRect(0.014, 0.0095, 0.001, 4)
    expect(pts).toHaveLength(20)
    for (const [x, y] of pts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.007 + 1e-9)
      expect(Math.abs(y)).toBeLessThanOrEqual(0.00475 + 1e-9)
    }
  })

  it("keeps the rim thin", () => {
    expect(rimWidth(0.014, 0.0095)).toBeCloseTo(0.00076)
    expect(rimWidth(0.002, 0.002)).toBe(0.0004)
    expect(rimWidth(0.05, 0.05)).toBe(0.0012)
  })

  it("thickens the rim while the overlay is on", () => {
    // An SFP cage: about twice the quiet rim, within its bounds.
    expect(rimWidth(0.014, 0.0095, true)).toBeCloseTo(0.001425)
    expect(rimWidth(0.002, 0.002, true)).toBe(0.0008)
    expect(rimWidth(0.05, 0.05, true)).toBe(0.0025)
    for (const [w, h] of [
      [0.014, 0.0095],
      [0.002, 0.002],
      [0.05, 0.05],
    ])
      expect(rimWidth(w, h, true)).toBeGreaterThan(rimWidth(w, h))
  })

  it("groups openings of one size", () => {
    expect(shapeKey({ w: 0.0142, h: 0.0095, r: 0 })).toBe(
      shapeKey({ w: 0.014200001, h: 0.0095, r: 0 })
    )
    expect(shapeKey({ w: 0.0142, h: 0.0095, r: 0 })).not.toBe(
      shapeKey({ w: 0.019, h: 0.0095, r: 0 })
    )
  })
})

describe("lighten", () => {
  it("mixes toward white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080")
    expect(lighten("#ffffff", 0.3)).toBe("#ffffff")
    expect(lighten("not-a-colour", 0.5)).toBe("not-a-colour")
  })
})

describe("rimRoom", () => {
  const shape = (w: number, h: number) => ({
    w,
    h,
    r: 0,
    u: [1, 0, 0] as [number, number, number],
    v: [0, 1, 0] as [number, number, number],
    n: [0, 0, 1] as [number, number, number],
  })

  it("gives each marker half the gap to its nearest neighbour", () => {
    // SFP28 cages: 13.8 mm wide, 14.25 mm apart; rows 15.05 mm apart.
    const s = shape(0.0138, 0.0083)
    const room = rimRoom([
      { at: [0, 0, 0], shape: s },
      { at: [0.01425, 0, 0], shape: s },
      { at: [0, -0.01505, 0], shape: s },
    ])
    expect(room[0]).toBeCloseTo(0.000225)
    expect(room[1]).toBeCloseTo(0.000225)
    expect(room[2]).toBeCloseTo(0.003375)
  })

  it("leaves a lone marker, or one on another face, unbounded", () => {
    const s = shape(0.01, 0.01)
    const rear = { ...s, n: [0, 0, -1] as [number, number, number] }
    expect(rimRoom([{ at: [0, 0, 0], shape: s }])).toEqual([Infinity])
    expect(
      rimRoom([
        { at: [0, 0, 0], shape: s },
        { at: [0.011, 0, 0], shape: rear },
      ])
    ).toEqual([Infinity, Infinity])
  })

  it("is zero for markers that already touch or overlap", () => {
    const s = shape(0.01, 0.01)
    expect(
      rimRoom([
        { at: [0, 0, 0], shape: s },
        { at: [0.009, 0, 0], shape: s },
      ])
    ).toEqual([0, 0])
  })
})
