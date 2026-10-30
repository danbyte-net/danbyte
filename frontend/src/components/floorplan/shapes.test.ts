import { describe, expect, it } from "vitest"

import { draftReducer, emptyDraft, initDraftHistory } from "./edit-history"
import {
  areaColor,
  areaName,
  labelPresetMm,
  labelPresetOf,
  pointInBox,
  polygonCrossesItself,
  resizeBox,
  rotateAngle,
  snapBounds,
  tileAnglePatch,
  tileQuarter,
  tileResidual,
} from "./shapes"
import type { Box } from "./shapes"

// The geometry of rooms, areas, labels and free tiles: turned boxes and
// their handles, snapping, label sizes in millimetres, and a free tile's
// angle beyond its quarter turn.

const box = (patch: Partial<Box> = {}): Box => ({
  x: 2,
  y: 2,
  width: 4,
  height: 2,
  rotation: 0,
  ...patch,
})

describe("resizing a box", () => {
  it("keeps the opposite corner where it is", () => {
    expect(resizeBox(box(), "se", [8, 5])).toEqual(box({ width: 6, height: 3 }))
    expect(resizeBox(box(), "nw", [1, 1])).toEqual(
      box({ x: 1, y: 1, width: 5, height: 3 })
    )
  })

  it("moves one side with a side handle", () => {
    expect(resizeBox(box(), "e", [9, 100])).toEqual(box({ width: 7 }))
  })

  it("never goes below its smallest size", () => {
    const b = resizeBox(box(), "se", [0, 0])
    expect(b.width).toBe(0.25)
    expect(b.height).toBe(0.25)
  })

  it("keeps its aspect from a corner with Shift", () => {
    const b = resizeBox(box(), "se", [10, 3], { keepAspect: true })
    expect(b.width / b.height).toBeCloseTo(2)
    expect(b.width).toBe(8)
  })

  it("works in a turned box's own frame", () => {
    // Turned a quarter, the box's right side faces down the plan: its east
    // handle (at 4, 5) pulled down 1 cell widens it by 1, about the west side.
    const turned = box({ rotation: 90 })
    const b = resizeBox(turned, "e", [4, 6])
    expect(b.width).toBeCloseTo(5)
    expect(b.height).toBeCloseTo(2)
    expect(b.rotation).toBe(90)
    // The west side stayed put: its middle is still 2 cells up the plan.
    expect(pointInBox([4, 1.1], b)).toBe(true)
  })
})

describe("turning a box", () => {
  it("points its top at the pointer", () => {
    // Centre (4, 3): straight right is a quarter turn.
    expect(rotateAngle(box(), [10, 3])).toBe(90)
    expect(rotateAngle(box(), [4, 10])).toBe(180)
  })

  it("settles near a quarter turn, or steps with Shift", () => {
    expect(rotateAngle(box(), [10, 3.3])).toBe(90)
    expect(rotateAngle(box(), [10, 3.3], { magnet: 0 })).not.toBe(90)
    expect(rotateAngle(box(), [7, 6], { step: 15 })).toBe(135)
  })
})

describe("snapping", () => {
  const lines = { xs: [10], ys: [] }
  it("pulls an edge onto a grid line or another shape's edge", () => {
    const s = snapBounds(
      { minX: 9.9, maxX: 12.3, minY: 0.05, maxY: 1.25 },
      lines,
      { step: 1, threshold: 0.2 }
    )
    expect(s.dx).toBeCloseTo(0.1)
    expect(s.gx).toBe(10)
    expect(s.dy).toBeCloseTo(-0.05)
  })

  it("leaves it alone out of reach", () => {
    const s = snapBounds(
      { minX: 3.4, maxX: 5.7, minY: 0.4, maxY: 2.6 },
      lines,
      {
        step: 1,
        threshold: 0.05,
      }
    )
    expect(s).toEqual({ dx: 0, dy: 0, gx: null, gy: null })
  })

  it("keeps a grid plan's shapes on half cells", () => {
    const s = snapBounds(
      { minX: 3.3, maxX: 5.3, minY: 1.1, maxY: 2 },
      { xs: [], ys: [] },
      { step: 1, threshold: 0.05, hardStep: 0.5 }
    )
    expect(3.3 + s.dx).toBeCloseTo(3.5)
    expect(1.1 + s.dy).toBeCloseTo(1)
  })
})

describe("polygons", () => {
  it("tell an outline that crosses itself", () => {
    expect(
      polygonCrossesItself([
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ])
    ).toBe(false)
    expect(
      polygonCrossesItself([
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
      ])
    ).toBe(true)
  })
})

describe("label sizes", () => {
  it("are millimetres on the floor, presets by the cell", () => {
    expect(labelPresetMm("S", 600)).toBe(150)
    expect(labelPresetMm("M", 600)).toBe(300)
    expect(labelPresetMm("L", 600)).toBe(450)
    expect(labelPresetMm("XL", 600)).toBe(750)
    expect(labelPresetMm("M", 1200)).toBe(600)
    expect(labelPresetOf(450, 600)).toBe("L")
    expect(labelPresetOf(320, 600)).toBeNull()
  })
})

describe("areas", () => {
  const room = { id: "r", name: "Room 210", code: "210", color: "#0ea5e9" }
  it("wear their room's colour, else their location's, else their own", () => {
    expect(areaColor({ room, location: null, color: "#ff0000" })).toBe(
      "#0ea5e9"
    )
    expect(
      areaColor({
        room: null,
        location: { id: "l", name: "Hall", color: "#22c55e" },
        color: "",
      })
    ).toBe("#22c55e")
    expect(areaColor({ room: null, location: null, color: "" })).toBe("#71717a")
  })

  it("are called by their label, else what they stand for", () => {
    expect(areaName({ label: "", room, location: null })).toBe("Room 210")
    expect(areaName({ label: "Cage 3", room, location: null })).toBe("Cage 3")
  })
})

describe("a free tile's angle", () => {
  const tile = { x: 2, y: 2, width: 2, height: 1, orientation: 0 }

  it("is its quarter turn plus what is left over", () => {
    expect(tileQuarter(30)).toBe(0)
    expect(tileResidual(30)).toBe(30)
    expect(tileQuarter(80)).toBe(90)
    expect(tileResidual(80)).toBe(-10)
    expect(tileQuarter(350)).toBe(0)
    expect(tileResidual(350)).toBe(-10)
  })

  it("swaps the footprint about its centre past 45°", () => {
    expect(tileAnglePatch(tile, 30)).toEqual({ ...tile, orientation: 30 })
    expect(tileAnglePatch(tile, 60)).toEqual({
      x: 2.5,
      y: 1.5,
      width: 1,
      height: 2,
      orientation: 60,
    })
  })
})

describe("undo", () => {
  it("covers areas and labels with the tiles", () => {
    type T = { id: string; x: number }
    let h = initDraftHistory(emptyDraft<T, T>([], [{ id: "a", x: 0 }]))
    h = draftReducer(h, {
      kind: "do",
      apply: (d) => ({ ...d, shapes: [{ id: "a", x: 3 }] }),
    })
    expect(h.present.shapes[0].x).toBe(3)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.shapes[0].x).toBe(0)
    h = draftReducer(h, { kind: "redo" })
    expect(h.present.shapes[0].x).toBe(3)
  })
})
