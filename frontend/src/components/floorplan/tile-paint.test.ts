import { describe, expect, it } from "vitest"

import type { FloorPlanTile, Rack } from "@/lib/api"
import { CAPACITY_HEX, CAPACITY_NONE_HEX } from "@/lib/rack-capacity"

import {
  COLOR_BY,
  metricRatio,
  rackFigures,
  rackTint,
  readColorBy,
  tilePaint,
  tintStamp,
} from "./tile-paint"
import type { RackFigures } from "./tile-paint"

// How a rack tile is painted under the plan's Color by (#247): the measure
// on the fill, monitoring on the stroke, and the figure always written on
// the tile - so a red fill (full) and a red outline (down) never blur.

const RACK_TYPE = {
  id: "tt1",
  name: "Rack",
  slug: "rack",
  color: "#3b82f6",
  icon: "",
  default_width: 1,
  default_height: 1,
  is_zone: false,
  has_fov: false,
}

const tile = (patch: Partial<FloorPlanTile> = {}) =>
  ({
    color: "",
    tile_type: RACK_TYPE,
    role_type: null,
    status: "",
    linked: { kind: "rack", id: "r1", name: "A01", route: "/racks/r1" },
    ...patch,
  }) as FloorPlanTile

const fig = (patch: Partial<RackFigures> = {}): RackFigures => ({
  used_units: 21,
  u_height: 42,
  power: { available_w: 4_000, allocated_w: 1_000, maximum_w: 0 },
  ports: { total: 48, connected: 30, reserved: 6, free: 12, marked: 0 },
  panel_ports: { total: 0, connected: 0, reserved: 0, free: 0, marked: 0 },
  role: { name: "Compute", color: "#6366f1" },
  status: { id: "s1", name: "Active", color: "#16a34a", text_color: "" },
  ...patch,
})

describe("readColorBy", () => {
  it("reads a stored choice, anything else as Type", () => {
    for (const c of COLOR_BY) expect(readColorBy(c)).toBe(c)
    expect(readColorBy(undefined)).toBe("type")
    expect(readColorBy("tenant")).toBe("type")
    expect(readColorBy(3)).toBe("type")
  })
})

describe("tilePaint", () => {
  it("draws Type as the plan always looked", () => {
    const linked = tilePaint({ tile: tile(), colorBy: "type", rack: fig() })
    expect(linked).toMatchObject({
      fill: "#3b82f6",
      fillOpacity: 0.26,
      stroke: "#3b82f6",
      strokeOpacity: 0.55,
      strokeWidth: 1,
      alarm: false,
      muted: false,
      opacity: 1,
    })
    // A rack's space bar, its figure written only where there is room.
    expect(linked.figure).toEqual({
      ratio: 0.5,
      color: CAPACITY_HEX.good,
      text: "50%",
      always: false,
    })
    const planning = tilePaint({
      tile: tile({ linked: null }),
      colorBy: "type",
      rack: null,
    })
    expect(planning.fillOpacity).toBe(0.13)
    expect(planning.figure).toBeNull()
  })

  it("fills a rack with its level on the measure and always writes it", () => {
    const at = (used_units: number) =>
      tilePaint({ tile: tile(), colorBy: "space", rack: fig({ used_units }) })
    expect(at(21).fill).toBe(CAPACITY_HEX.good)
    expect(at(36).fill).toBe(CAPACITY_HEX.warn)
    // 40 of 42 is 95.2 %: above the critical line.
    const full = at(40)
    expect(full.fill).toBe(CAPACITY_HEX.critical)
    expect(full.figure).toEqual({
      ratio: 40 / 42,
      color: CAPACITY_HEX.critical,
      text: "95%",
      always: true,
    })
    expect(full.fillOpacity).toBeGreaterThan(0.26)
  })

  it("keeps monitoring on the stroke, whatever the fill says", () => {
    const down = tilePaint({
      tile: tile(),
      colorBy: "space",
      rack: fig({ used_units: 10 }),
      check: "down",
    })
    expect(down.fill).toBe(CAPACITY_HEX.good)
    expect(down.stroke).toBe("#ef4444")
    expect(down.alarm).toBe(true)
    expect(down.strokeWidth).toBe(2)
    expect(down.strokeOpacity).toBe(1)
    const degraded = tilePaint({
      tile: tile(),
      colorBy: "power",
      rack: fig(),
      check: "degraded",
    })
    expect(degraded.stroke).toBe("#f59e0b")
    // An up check is no alarm: the stroke follows the fill.
    const up = tilePaint({
      tile: tile(),
      colorBy: "ports",
      rack: fig(),
      check: "up",
    })
    expect(up.alarm).toBe(false)
    expect(up.stroke).toBe(up.fill)
  })

  it("reads no data grey, and says so on the tile", () => {
    // Demand with no feed: nothing to measure power against.
    const noFeed = tilePaint({
      tile: tile(),
      colorBy: "power",
      rack: fig({
        power: { available_w: 0, allocated_w: 900, maximum_w: 0 },
      }),
    })
    expect(noFeed.fill).toBe(CAPACITY_NONE_HEX)
    expect(noFeed.figure).toMatchObject({ ratio: null, text: "No data" })
    // No panel ports counted.
    expect(
      tilePaint({ tile: tile(), colorBy: "panel_ports", rack: fig() }).figure
        ?.text
    ).toBe("No data")
    // Before the plan's racks arrive, a measure only they carry.
    expect(
      tilePaint({
        tile: tile(),
        colorBy: "ports",
        rack: rackFigures(null, {
          kind: "rack",
          used_units: 1,
          u_height: 42,
          power: { available_w: 0, allocated_w: 0, maximum_w: 0 },
          total_weight_kg: 0,
          max_weight_kg: null,
          device_count: 1,
          check: null,
        }),
      }).fill
    ).toBe(CAPACITY_NONE_HEX)
  })

  it("colours by the rack's own role and status, grey without one", () => {
    const role = tilePaint({ tile: tile(), colorBy: "role", rack: fig() })
    expect(role.fill).toBe("#6366f1")
    // The categorical modes keep the space bar, as Type does.
    expect(role.figure).toMatchObject({ text: "50%", always: false })
    const status = tilePaint({ tile: tile(), colorBy: "status", rack: fig() })
    expect(status.fill).toBe("#16a34a")
    expect(
      tilePaint({ tile: tile(), colorBy: "role", rack: fig({ role: null }) })
        .fill
    ).toBe(CAPACITY_NONE_HEX)
  })

  it("mutes what is no rack while racks are coloured", () => {
    for (const linked of [
      null,
      { kind: "device" as const, id: "d1", name: "ap", route: "/devices/d1" },
    ]) {
      const p = tilePaint({
        tile: tile({ linked, color: "#ef4444" }),
        colorBy: "space",
        rack: null,
      })
      expect(p.muted).toBe(true)
      expect(p.fill).toBe(CAPACITY_NONE_HEX)
      expect(p.figure).toBeNull()
    }
  })

  it("fades what the rack table filters out, and a decommissioning tile", () => {
    expect(
      tilePaint({ tile: tile(), colorBy: "space", rack: fig(), dimmed: true })
        .opacity
    ).toBe(0.25)
    expect(
      tilePaint({
        tile: tile({ status: "decommissioning" }),
        colorBy: "type",
        rack: fig(),
      }).opacity
    ).toBe(0.55)
  })
})

describe("rack figures", () => {
  it("take units and power from the live poll over the plan's row", () => {
    const row = {
      used_units: 10,
      u_height: 42,
      power: { available_w: 1, allocated_w: 1, maximum_w: 1 },
      ports: fig().ports,
      panel_ports: null,
      role: null,
      status: null,
    } as unknown as Rack
    const f = rackFigures(row, {
      kind: "rack",
      used_units: 12,
      u_height: 42,
      power: { available_w: 3_000, allocated_w: 2_700, maximum_w: 0 },
      total_weight_kg: 0,
      max_weight_kg: null,
      device_count: 4,
      check: null,
    })!
    expect(f.used_units).toBe(12)
    expect(metricRatio(f, "power")).toBe(0.9)
    // Ports are the row's: connected plus reserved, over the total.
    expect(metricRatio(f, "ports")).toBe(36 / 48)
    expect(rackFigures(null, null)).toBeNull()
  })
})

describe("3D tints", () => {
  it("are the 2D fill, and none under Type", () => {
    expect(rackTint("type", fig())).toBeNull()
    expect(rackTint("space", fig())).toBe(CAPACITY_HEX.good)
    expect(rackTint("power", null)).toBe(CAPACITY_NONE_HEX)
    expect(rackTint("role", fig())).toBe("#6366f1")
  })

  it("stamp the room so a tint change redraws it", () => {
    const a = new Map([
      ["t1", CAPACITY_HEX.good],
      ["t2", CAPACITY_HEX.warn],
    ])
    // The same colours in another order: the same picture, no redraw.
    const same = new Map([
      ["t2", CAPACITY_HEX.warn],
      ["t1", CAPACITY_HEX.good],
    ])
    const changed = new Map([
      ["t1", CAPACITY_HEX.good],
      ["t2", CAPACITY_HEX.critical],
    ])
    expect(tintStamp(same)).toBe(tintStamp(a))
    expect(tintStamp(changed)).not.toBe(tintStamp(a))
    expect(tintStamp(new Map())).toBe("")
  })
})
