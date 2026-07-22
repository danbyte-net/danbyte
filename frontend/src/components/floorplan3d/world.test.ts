import { describe, expect, it } from "vitest"

import {
  RACK_BASE_M,
  cellToWorld,
  deviceYM,
  rackFootprintM,
  trayElevationM,
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
