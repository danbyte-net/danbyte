import { describe, expect, it } from "vitest"

import {
  DETAIL_ENTER_PX_PER_M,
  ROOM_ENTER_PX_PER_M,
  pxPerMetre,
} from "./plan-detail"
import { planRooms } from "./plan-lod"
import {
  clickZoomTarget,
  easeInOut,
  roomBox,
  roomLevelK,
  rowZoomMinK,
  viewAt,
} from "./plan-zoom"
import type { AreaShape } from "./shapes"

// Click to zoom (plan-zoom.ts): what a click on a room or a row's bar zooms
// to, and the eased path there.

const CELL = 40
const MM = 1000 // a metre a cell: 40 px a metre at zoom 1

const area = (id: string, patch: Partial<AreaShape>): AreaShape =>
  ({
    kind: "area",
    id,
    shape: "rect",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    points: [],
    room: null,
    location: null,
    label: id,
    color: "",
    fill_opacity: 12,
    border: "solid",
    show_name: true,
    z: 0,
    locked: false,
    created_at: "",
    updated_at: "",
    ...patch,
  }) as AreaShape

const campus = planRooms([
  area("Building A", { x: 100, y: 100, width: 40, height: 300 }),
  area("Office A", { x: 110, y: 110, width: 10, height: 10 }),
  area("Courtyard", { x: 300, y: 300, width: 60, height: 40 }),
])
const opts = { cell: CELL, cellMm: MM }
const far = { k: 0.02, x: 0, y: 0 } // 0.8 px a metre: the campus whole

describe("click to zoom", () => {
  it("fits the building clicked on a campus", () => {
    const hit = clickZoomTarget(campus, [115, 115], far, 800, 600, opts)!
    expect(hit.room.id).toBe("Building A")
    // 300 cells in 536 px.
    expect(hit.view.k).toBeCloseTo((600 - 64) / (300 * CELL))
    // Still seen from afar: 1.8 px a metre.
    expect(hit.level).toBe("overview")
    // Centred on the building.
    const box = roomBox(hit.room)
    expect(hit.view.x + (box.x + box.w / 2) * CELL * hit.view.k).toBeCloseTo(
      400
    )
    expect(hit.view.y + (box.y + box.h / 2) * CELL * hit.view.k).toBeCloseTo(
      300
    )
  })

  it("then the room inside it, fitted", () => {
    const first = clickZoomTarget(campus, [115, 115], far, 800, 600, opts)!
    const hit = clickZoomTarget(campus, [115, 115], first.view, 800, 600, opts)!
    expect(hit.room.id).toBe("Office A")
    // 10 cells in 536 px high: 1.34.
    expect(hit.view.k).toBeCloseTo((600 - 64) / (10 * CELL))
    expect(hit.level).toBe(
      pxPerMetre(CELL * hit.view.k, MM) >= DETAIL_ENTER_PX_PER_M
        ? "detail"
        : "room"
    )
  })

  it("goes in to the room level about the point when nothing smaller fits", () => {
    const first = clickZoomTarget(campus, [130, 300], far, 800, 600, opts)!
    expect(first.level).toBe("overview")
    const hit = clickZoomTarget(campus, [130, 300], first.view, 800, 600, opts)!
    expect(hit.room.id).toBe("Building A")
    expect(hit.view.k).toBeCloseTo(roomLevelK(MM, CELL))
    expect(hit.level).toBe("room")
    // The point clicked at the middle of the screen.
    expect(hit.view.x + 130 * CELL * hit.view.k).toBeCloseTo(400)
    expect(hit.view.y + 300 * CELL * hit.view.k).toBeCloseTo(300)
    expect(ROOM_ENTER_PX_PER_M).toBeLessThan(pxPerMetre(CELL * hit.view.k, MM))
  })

  it("zooms nowhere once the room fills the screen, or off every room", () => {
    const close = { k: 2, x: 0, y: 0 }
    expect(
      clickZoomTarget(campus, [115, 115], close, 800, 600, opts)
    ).toBeNull()
    expect(clickZoomTarget(campus, [500, 50], far, 800, 600, opts)).toBeNull()
    expect(clickZoomTarget(campus, [115, 115], far, 0, 0, opts)).toBeNull()
  })

  it("takes a row to the detail level", () => {
    expect(pxPerMetre(CELL * rowZoomMinK(600, CELL), 600)).toBeGreaterThan(
      DETAIL_ENTER_PX_PER_M
    )
  })

  it("eases in and out from one view to the other", () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.1)).toBeLessThan(0.1)
    const a = { k: 0.1, x: 0, y: 0 }
    const b = { k: 1, x: -500, y: -300 }
    expect(viewAt(a, b, 0, 800, 600)).toEqual(a)
    expect(viewAt(a, b, 1, 800, 600)).toEqual(b)
    // Halfway in scale is the geometric middle.
    expect(viewAt(a, b, 0.5, 800, 600).k).toBeCloseTo(Math.sqrt(0.1))
  })
})
