import { describe, expect, it } from "vitest"

import type { FloorPlanArea, FloorPlanLabel } from "@/lib/api"
import {
  PAGE_DARK,
  PAGE_LIGHT,
  areaLabelColor,
  areaNameHaloColor,
} from "@/components/floorplan/shapes"
import type { AreaShape, LabelShape } from "@/components/floorplan/shapes"

import { layoutNames3D } from "./name-layout"
import type { Name3D } from "./name-layout"
import {
  FLAT_ENTER,
  FLAT_EXIT,
  PLAN_TEXT_RANK,
  areaInk3D,
  areaText,
  flatQuad,
  labelInk3D,
  labelText,
  layoutPlanTexts,
  longestLegMiddle,
  planTextMode,
  planTextPriority,
  planTexts,
  rowTexts,
  trayName,
  zoneText,
} from "./plan-text"
import type { ScenePayload, SceneTile, SceneTray } from "./world"

// The plan's own text in the 3D room: what shows under which toggle, where
// it sits on the floor, in which ink, and how it ranks against the
// Readable name plates in the one collision pass.

function area(patch: Partial<FloorPlanArea> = {}): AreaShape {
  return {
    kind: "area",
    id: "a1",
    shape: "rect",
    x: 4,
    y: 2,
    width: 6,
    height: 4,
    rotation: 0,
    points: [],
    room: { id: "r1", name: "R210", code: "", color: "#2563eb" },
    location: null,
    label: "",
    color: "",
    fill_opacity: 15,
    border: "solid",
    show_name: true,
    z: 0,
    locked: false,
    created_at: "",
    updated_at: "",
    ...patch,
  }
}

function label(patch: Partial<FloorPlanLabel> = {}): LabelShape {
  return {
    kind: "label",
    id: "l1",
    text: "COLD AISLE",
    x: 2,
    y: 3,
    width: null,
    height: null,
    rotation: 0,
    font_mm: 300,
    weight: "normal",
    align: "left",
    color: "",
    plate: false,
    z: 0,
    locked: false,
    created_at: "",
    updated_at: "",
    ...patch,
  }
}

function tile(patch: Partial<SceneTile> = {}): SceneTile {
  return {
    id: "t1",
    x: 1,
    y: 1,
    w: 4,
    h: 2,
    orientation: 0,
    status: "active",
    label: "Zone A",
    kind: "other",
    color: "#16a34a",
    is_zone: true,
    rack: null,
    ...patch,
  }
}

function tray(patch: Partial<SceneTray> = {}): SceneTray {
  return {
    id: "tr1",
    name: "T-01",
    kind: "ladder",
    color: "",
    level: "overhead",
    elevation_mm: null,
    points: [
      [0, 0],
      [2, 0],
      [2, 8],
    ],
    cable_count: 3,
    ...patch,
  }
}

const plan = {
  id: "p1",
  name: "Hall",
  grid_width: 20,
  grid_height: 20,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 1,
} as ScenePayload["plan"]

const scene = {
  plan,
  tiles: [tile(), tile({ id: "t2", is_zone: false, label: "R-01" })],
  trays: [tray()],
  raised_floors: [],
}

const all = { labels: true, areaNames: true, zoneNames: true }

describe("planTexts", () => {
  it("writes labels, tray, zone and area names under their toggles", () => {
    const ids = (show: typeof all) =>
      planTexts({
        scene,
        areas: [area()],
        labels: [label()],
        show,
        dark: false,
      }).map((i) => i.id)
    expect(ids(all).sort()).toEqual(
      ["area:a1", "label:l1", "tray:tr1", "zone:t1"].sort()
    )
    expect(ids({ ...all, labels: false }).sort()).toEqual([
      "area:a1",
      "zone:t1",
    ])
    expect(ids({ ...all, areaNames: false }).sort()).toEqual(
      ["label:l1", "tray:tr1", "zone:t1"].sort()
    )
    expect(ids({ ...all, zoneNames: false })).not.toContain("zone:t1")
  })

  it("never names a tile that is not a zone, nor an empty label", () => {
    expect(zoneText(tile({ is_zone: false }), false)).toBeNull()
    expect(zoneText(tile({ label: "" }), false)).toBeNull()
    expect(labelText(label({ text: "  " }), 600, false)).toBeNull()
  })
})

describe("rowTexts", () => {
  // Four racks side by side in a room: one row, named beside it.
  const rack = (i: number) =>
    tile({
      id: `r${i}`,
      x: 5 + i,
      y: 3,
      w: 1,
      h: 2,
      label: `DH5-B0${i + 1}`,
      kind: "rack",
      is_zone: false,
    })
  const racks = [0, 1, 2, 3].map(rack)
  const room = area({ x: 2, y: 1, width: 12, height: 8 })

  it("names a row once along it, inside its room", () => {
    const [row, ...more] = rowTexts(racks, [room], false)
    expect(more).toEqual([])
    expect(row.kind).toBe("row")
    expect(row.lines).toEqual(["Row B · B01–B04"])
    expect(row.rotation).toBe(0)
    // Beside the row, not over it.
    expect(row.at[0]).toBeCloseTo(7)
    expect(Math.abs(row.at[1] - 4)).toBeGreaterThan(1)
    expect(row.room?.outline).toHaveLength(4)
  })

  it("needs three of a kind, and no room is no region", () => {
    expect(rowTexts(racks.slice(0, 2), [room], false)).toEqual([])
    expect(rowTexts(racks, [], false)[0].room).toBeUndefined()
  })

  it("shows under Callouts: Auto only", () => {
    const ids = (rowNames: boolean) =>
      planTexts({
        scene: { ...scene, tiles: racks },
        areas: [],
        labels: [],
        show: { ...all, rowNames },
        dark: false,
      }).map((i) => i.id)
    expect(ids(true)).toContain("row:r0")
    expect(ids(false)).not.toContain("row:r0")
  })
})

describe("areaText", () => {
  it("follows Show the name", () => {
    expect(areaText(area({ show_name: false }), false)).toBeNull()
    expect(areaText(area(), false)?.lines).toEqual(["R210"])
    // Its own label wins over the room's name.
    expect(areaText(area({ label: "Hall A" }), false)?.lines).toEqual([
      "Hall A",
    ])
  })

  it("sits in a rectangle's top left, turned with it", () => {
    const t = areaText(area(), false)!
    expect(t.pivot).toEqual([0, 0])
    expect(t.at[0]).toBeGreaterThan(4)
    expect(t.at[0]).toBeLessThan(4.3)
    expect(t.at[1]).toBeGreaterThan(2)
    expect(t.at[1]).toBeLessThan(2.3)
    const turned = areaText(area({ rotation: 90 }), false)!
    expect(turned.rotation).toBe(90)
    // A quarter turn about the middle (7, 4) puts the top left top right.
    expect(turned.at[0]).toBeGreaterThan(8.5)
  })

  it("centres a polygon's name on its middle", () => {
    const t = areaText(
      area({
        shape: "polygon",
        points: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
      }),
      false
    )!
    expect(t.pivot).toEqual([0.5, 0.5])
    expect(t.at[0]).toBeCloseTo(2)
    expect(t.at[1]).toBeCloseTo(2)
  })

  it("leaves a room too small for its name, unless Readable", () => {
    const tiny = area({ width: 0.5, height: 0.3 })
    expect(areaText(tiny, false)).toBeNull()
    expect(areaText(tiny, false, true)).not.toBeNull()
  })

  it("inks the name by the 2D rule: own colour on a light fill, black or white on a strong one", () => {
    const light = areaInk3D(area(), false)
    // A light fill: the colour mixed with the page's ink, on a halo of
    // the page (the fill is under 50 %).
    expect(light.color).not.toBe("#2563eb")
    expect(light.halo).toBe(PAGE_LIGHT)
    const strong = area({ fill_opacity: 80 })
    const ink = areaLabelColor(strong, PAGE_DARK)
    const s = areaInk3D(strong, true)
    expect(s.color).toBe(ink)
    // A strong fill is its own backdrop: no halo, unless Readable.
    expect(s.halo).toBeNull()
    expect(areaInk3D(strong, true, true).halo).toBe(areaNameHaloColor(ink))
  })
})

describe("labelText", () => {
  it("keeps the label's size, rotation and box", () => {
    const t = labelText(
      label({ rotation: 30, width: 4, height: 1, font_mm: 450 }),
      600,
      false
    )!
    expect(t.fontCells).toBeCloseTo(0.75)
    expect(t.rotation).toBe(30)
    expect(t.minBox).toEqual({ w: 4, h: 1 })
    expect(t.at).toEqual([4, 3.5])
    expect(t.pivot).toEqual([0.5, 0.5])
    expect(labelText(label({ text: "A\nB" }), 600, false)!.lines).toEqual([
      "A",
      "B",
    ])
  })

  it("wears its colour token for the theme, and its plate", () => {
    expect(labelInk3D(label({ color: "red" }), false).color).toBe("#dc2626")
    expect(labelInk3D(label({ color: "red" }), true).color).toBe("#f87171")
    const plated = labelInk3D(label({ plate: true }), true)
    expect(plated.plate).toBe(PAGE_DARK)
    expect(plated.halo).toBeNull()
    // A coloured plate: its fill, and the ink that reads over it.
    const blue = labelInk3D(label({ plate: true, plate_color: "blue" }), false)
    expect(blue.plate).toBe("#2563eb")
    expect(blue.color).toBe("#fff")
  })
})

describe("trays", () => {
  it("names a tray as 2D does, over its longest leg", () => {
    expect(trayName(tray())).toBe("T-01 · 3")
    expect(trayName(tray({ hidden_cable_count: 2 }))).toBe(
      "T-01 · 3 · 2 hidden"
    )
    expect(trayName(tray({ name: "" }))).toBe("")
    expect(longestLegMiddle(tray().points)).toEqual([2, 4])
    expect(longestLegMiddle([[1, 1]])).toBeNull()
  })
})

describe("flatQuad", () => {
  it("places a top-left pivot's quad right and down of it", () => {
    const q = flatQuad({ at: [10, 10], pivot: [0, 0], rotation: 0 }, 4, 1)
    expect(q.centre).toEqual([12, 10.5])
    expect(q.corners[0]).toEqual([10, 10])
  })

  it("grows about the pivot and turns about it", () => {
    const q = flatQuad({ at: [10, 10], pivot: [0, 0], rotation: 0 }, 4, 1, 2)
    expect(q.corners[0]).toEqual([10, 10])
    expect(q.centre).toEqual([14, 11])
    const c = flatQuad({ at: [5, 5], pivot: [0.5, 0.5], rotation: 90 }, 4, 2)
    expect(c.centre).toEqual([5, 5])
    // Turned a quarter: its long side runs down the plan.
    const ys = c.corners.map((p) => p[1])
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4)
  })
})

describe("planTextMode", () => {
  it("stands flat text up from low down, with hysteresis", () => {
    expect(planTextMode(0.9)).toBe("flat")
    expect(planTextMode(FLAT_EXIT - 0.01, "flat")).toBe("billboard")
    // Between the thresholds it keeps what it was.
    const mid = (FLAT_EXIT + FLAT_ENTER) / 2
    expect(planTextMode(mid, "flat")).toBe("flat")
    expect(planTextMode(mid, "billboard")).toBe("billboard")
    expect(planTextMode(FLAT_ENTER + 0.01, "billboard")).toBe("flat")
  })
})

describe("the one collision pass", () => {
  const plate = (id: string, x: number, pinned = false): Name3D => ({
    id,
    name: id,
    kind: "rack",
    icon: "",
    color: "#333",
    x,
    y: 100,
    w: 60,
    h: 18,
    priority: 1e6 - 10,
    pinned,
  })
  const text = (id: string, kind: "label" | "area" | "zone", x: number) => ({
    id,
    x: x - 30,
    y: 82,
    w: 60,
    h: 18,
    priority: planTextPriority(kind, 10),
  })
  const opts = {
    view: { x: 0, y: 0, w: 800, h: 600 },
    callouts: false,
    plateSize: () => ({ w: 60, h: 18 }),
  }

  it("ranks labels over plates, plates over zone and area names", () => {
    expect(PLAN_TEXT_RANK.label).toBeGreaterThan(1e6)
    expect(PLAN_TEXT_RANK.area).toBeLessThan(PLAN_TEXT_RANK.zone)
    expect(PLAN_TEXT_RANK.zone).toBeLessThan(-1e6)
    const l = layoutNames3D([plate("r1", 100)], {
      ...opts,
      extras: [text("label:l1", "label", 100)],
    })
    expect(l.extras.has("label:l1")).toBe(true)
    expect(l.plain.has("r1")).toBe(false)
    const a = layoutNames3D([plate("r1", 100)], {
      ...opts,
      extras: [text("area:a1", "area", 100)],
    })
    expect(a.plain.has("r1")).toBe(true)
    expect(a.extras.has("area:a1")).toBe(false)
  })

  it("keeps the selected or hovered plate over a label", () => {
    const l = layoutNames3D([plate("r1", 100, true)], {
      ...opts,
      extras: [text("label:l1", "label", 100)],
    })
    expect(l.plain.has("r1")).toBe(true)
    expect(l.extras.has("label:l1")).toBe(false)
  })

  it("keeps callouts off the labels that show", () => {
    // A crowd of plates over a label: they go in boxes, none on it.
    const crowd = [0, 1, 2].map((i) => plate(`r${i}`, 300 + i * 20))
    const lab = text("label:l1", "label", 320)
    const l = layoutNames3D(crowd, { ...opts, callouts: true, extras: [lab] })
    expect(l.extras.has("label:l1")).toBe(true)
    for (const c of l.callouts.values())
      expect(
        c.box.x < lab.x + lab.w &&
          lab.x < c.box.x + c.box.w &&
          c.box.y < lab.y + lab.h &&
          lab.y < c.box.y + c.box.h
      ).toBe(false)
  })

  it("thins the plan text alone when no plates run the pass", () => {
    const kept = layoutPlanTexts([
      text("area:a1", "area", 100),
      text("label:l1", "label", 110),
      text("zone:z1", "zone", 400),
    ])
    expect([...kept].sort()).toEqual(["label:l1", "zone:z1"])
  })
})
