import { describe, expect, it } from "vitest"

import {
  RACK_BASE_M,
  airflowGlyphPlacements,
  cellToWorld,
  deviceBoxM,
  deviceYM,
  rackFootprintM,
  trayElevationM,
  underfloorMM,
  type SceneRack,
  type SceneTray,
  type ScenePayload,
} from "./world"

const plan: ScenePayload["plan"] = {
  id: "p",
  name: "Hall",
  grid_width: 24,
  grid_height: 16,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
}

const rack = (over: Partial<SceneRack> = {}): SceneRack => ({
  id: "r",
  name: "R01",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  outer_width_mm: null,
  outer_depth_mm: null,
  devices: [],
  ...over,
})

const dev = (position: number, u = 1, over = {}) => ({
  id: "d",
  name: "sw",
  position,
  face: "" as const,
  rack_side: "" as const,
  u_height: u,
  rack_width: "full" as const,
  is_full_depth: true,
  role_color: "",
  role_name: "",
  device_type: "",
  status: null,
  primary_ip: null,
  serial_number: "",
  front_image: null,
  rear_image: null,
  has_faceplate: false,
  image_ports: null,
  ...over,
})

describe("cellToWorld", () => {
  it("maps cells to metres via cell_mm", () => {
    expect(cellToWorld(plan, 10, 5)).toEqual([6, 3])
  })
})

describe("deviceYM — must mirror the 2D elevation's unit math exactly", () => {
  it("ascending units: U1 sits on the base, U42 at the top", () => {
    const r = rack()
    const u1 = deviceYM(r, dev(1))
    expect(u1.y).toBeCloseTo(RACK_BASE_M)
    expect(u1.h).toBeCloseTo(0.04445)
    const u42 = deviceYM(r, dev(42))
    expect(u42.y).toBeCloseTo(RACK_BASE_M + 41 * 0.04445)
  })

  it("multi-U device occupies position upward (ascending)", () => {
    // A 4U server at position 10 spans U10–13; bottom = slot 9.
    const { y, h } = deviceYM(rack(), dev(10, 4))
    expect(y).toBeCloseTo(RACK_BASE_M + 9 * 0.04445)
    expect(h).toBeCloseTo(4 * 0.04445)
  })

  it("desc_units: position numbers from the top, physically spans downward", () => {
    // 42U rack, desc numbering: U1 is the TOP slot. A 2U device at position 1
    // occupies the two topmost slots → bottom slot index 40.
    const r = rack({ desc_units: true })
    const { y } = deviceYM(r, dev(1, 2))
    expect(y).toBeCloseTo(RACK_BASE_M + 40 * 0.04445)
    // …and at position 41 it fills the bottom two slots.
    const low = deviceYM(r, dev(41, 2))
    expect(low.y).toBeCloseTo(RACK_BASE_M)
  })

  it("starting_unit offsets the numbering, not the geometry", () => {
    const r = rack({ starting_unit: 10 })
    expect(deviceYM(r, dev(10)).y).toBeCloseTo(RACK_BASE_M)
  })
})

describe("rackFootprintM", () => {
  it("derives width from the rail opening + frame when not recorded", () => {
    const { width, depth } = rackFootprintM(rack())
    expect(width).toBeCloseTo(0.6) // 450 + 150 mm
    expect(depth).toBeCloseTo(1.0)
  })
  it("uses recorded outer dimensions when present", () => {
    const { width, depth } = rackFootprintM(
      rack({ outer_width_mm: 800, outer_depth_mm: 1200 })
    )
    expect(width).toBeCloseTo(0.8)
    expect(depth).toBeCloseTo(1.2)
  })
})

describe("trayElevationM", () => {
  const tray = (over: Partial<SceneTray>): SceneTray => ({
    id: "t",
    name: "T",
    kind: "",
    color: "",
    level: "overhead",
    elevation_mm: null,
    points: [],
    cable_count: 0,
    ...over,
  })
  it("derives from level when elevation is blank", () => {
    expect(trayElevationM(plan, tray({ level: "overhead" }))).toBeCloseTo(2.7)
    expect(trayElevationM(plan, tray({ level: "underfloor" }))).toBeCloseTo(
      -0.3
    )
    expect(trayElevationM(plan, tray({ level: "floor" }))).toBe(0)
  })
  it("an explicit elevation always wins", () => {
    expect(
      trayElevationM(plan, tray({ level: "overhead", elevation_mm: 2400 }))
    ).toBeCloseTo(2.4)
  })
})

describe("airflowGlyphPlacements", () => {
  const box = () => deviceBoxM(rack(), dev(10, 2), 0.6, 1.0)

  it("draws nothing for passive, unknown or blank airflow", () => {
    expect(airflowGlyphPlacements("passive", box())).toEqual([])
    expect(airflowGlyphPlacements("", box())).toEqual([])
    expect(airflowGlyphPlacements(undefined, box())).toEqual([])
    expect(airflowGlyphPlacements("bottom-to-top", box())).toEqual([])
  })

  it("front-to-rear: intake on the front plane, exhaust on the rear, both +Z", () => {
    const b = box()
    const g = airflowGlyphPlacements("front-to-rear", b)
    const intake = g.filter((x) => x.kind === "intake")
    const exhaust = g.filter((x) => x.kind === "exhaust")
    expect(intake.length).toBeGreaterThan(0)
    expect(intake.length).toBe(exhaust.length)
    for (const i of intake) {
      expect(i.dir).toEqual([0, 0, 1])
      expect(i.pos[2]).toBeLessThan(b.dz - b.dd / 2) // off the front plane
    }
    for (const e of exhaust) {
      expect(e.dir).toEqual([0, 0, 1])
      expect(e.pos[2]).toBeGreaterThan(b.dz + b.dd / 2)
    }
  })

  it("rear-to-front mirrors the direction and the faces", () => {
    const b = box()
    const g = airflowGlyphPlacements("rear-to-front", b)
    for (const x of g) expect(x.dir).toEqual([0, 0, -1])
    const intake = g.filter((x) => x.kind === "intake")
    for (const i of intake) expect(i.pos[2]).toBeGreaterThan(b.dz + b.dd / 2)
  })

  it("side flows run along ±X on the side planes", () => {
    const b = box()
    const lr = airflowGlyphPlacements("left-to-right", b)
    for (const x of lr) expect(x.dir).toEqual([1, 0, 0])
    const rl = airflowGlyphPlacements("right-to-left", b)
    for (const x of rl) expect(x.dir).toEqual([-1, 0, 0])
    const inL = lr.filter((x) => x.kind === "intake")
    for (const i of inL) expect(i.pos[0]).toBeLessThan(b.dx - b.dw / 2)
  })

  it("mixed draws exactly one intake + one exhaust on the exposed face", () => {
    const g = airflowGlyphPlacements("mixed", box())
    expect(g.map((x) => x.kind).sort()).toEqual(["exhaust", "intake"])
  })

  it("glyphs sit at the device's vertical centre", () => {
    const b = box()
    for (const x of airflowGlyphPlacements("front-to-rear", b))
      expect(x.pos[1]).toBeCloseTo(b.y + b.h / 2)
  })
})

describe("underfloorMM + area-aware trayElevationM", () => {
  const tray = (over: Partial<SceneTray>): SceneTray => ({
    id: "t",
    name: "T",
    kind: "",
    color: "",
    level: "overhead",
    elevation_mm: null,
    points: [],
    cable_count: 0,
    ...over,
  })
  const area = (
    x: number,
    y: number,
    w: number,
    h: number,
    plenum: number
  ) => ({
    id: `a${x}`,
    x,
    y,
    w,
    h,
    plenum_mm: plenum,
    label: "",
    color: "",
  })

  it("falls back to 300 outside every area (the historical constant)", () => {
    expect(underfloorMM(undefined, [[1, 1]])).toBe(300)
    expect(underfloorMM([area(10, 10, 4, 4, 600)], [[1, 1]])).toBe(300)
  })

  it("takes the deepest plenum a run crosses", () => {
    const areas = [area(0, 0, 10, 10, 400), area(10, 0, 10, 10, 700)]
    expect(
      underfloorMM(areas, [
        [2, 2],
        [8, 2],
      ])
    ).toBe(400)
    expect(
      underfloorMM(areas, [
        [8, 2],
        [12, 2],
      ])
    ).toBe(700)
  })

  it("trayElevationM derives −plenum for underfloor runs in an area", () => {
    const areas = [area(0, 0, 20, 16, 600)]
    const t = tray({
      level: "underfloor",
      points: [
        [2, 2],
        [6, 2],
      ],
    })
    expect(trayElevationM(plan, t, areas)).toBeCloseTo(-0.6)
    // Back-compat: omitted areas keep the historical −0.3.
    expect(trayElevationM(plan, t)).toBeCloseTo(-0.3)
    // Explicit elevation still always wins.
    expect(
      trayElevationM(
        plan,
        tray({ level: "underfloor", elevation_mm: -450 }),
        areas
      )
    ).toBeCloseTo(-0.45)
  })
})
