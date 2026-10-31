// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanWallOpening } from "@/lib/api"
import { FloorCanvas } from "./floor-canvas"
import type { FloorCanvasProps } from "./floor-canvas"
import type { RaisedRow, StructShape, WallRow } from "./structure"

// Walls, doors and raised floors edited by mouse: a wall's points and
// segments dragged, an end dropped on another wall's end joining them, a
// door drawn with the Door tool, resized and slid by its handles and
// flipped, a double-click splitting a wall, a raised floor snapped to its
// neighbour, and the right-click menu on a wall. jsdom lays nothing out, so
// the plan sits at zoom 1, 40 px in: 40 px to a cell.

beforeAll(() => {
  Element.prototype.setPointerCapture = () => {}
})
afterEach(cleanup)

const plan = {
  id: "p1",
  name: "Hall",
  grid_width: 20,
  grid_height: 12,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
  layout_mode: "grid",
} as unknown as FloorPlan

const wall = (p: Partial<WallRow> = {}): WallRow => ({
  part: "wall",
  id: "w1",
  label: "",
  points: [
    [2, 2],
    [8, 2],
  ],
  height_mm: null,
  thickness_mm: null,
  color: "",
  openings: [],
  created_at: "",
  updated_at: "",
  ...p,
})
const raised = (p: Partial<RaisedRow> = {}): RaisedRow => ({
  part: "raised_floor",
  id: "r1",
  x: 0,
  y: 6,
  width: 4,
  height: 4,
  plenum_mm: 300,
  label: "",
  color: "",
  created_at: "",
  updated_at: "",
  ...p,
})
const opening = (
  p: Partial<FloorPlanWallOpening> = {}
): FloorPlanWallOpening => ({
  seg: 0,
  from: 1,
  to: 2,
  height_mm: null,
  ...p,
})

/** A pointer at (x, y) plan pixels. */
const at = (x: number, y: number, extra: object = {}) => ({
  pointerId: 1,
  button: 0,
  clientX: x + 40,
  clientY: y + 40,
  ...extra,
})

function draw(structure: StructShape[], props: Partial<FloorCanvasProps> = {}) {
  const onCommitStructure = vi.fn()
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={[]}
      selectedId={null}
      editable
      showGrid
      armed={null}
      mode="structure"
      structure={structure}
      walls={structure.filter((s) => s.part === "wall")}
      raisedFloors={structure.filter((s) => s.part === "raised_floor")}
      onCommitStructure={onCommitStructure}
      {...props}
    />
  )
  const svg = r.container.querySelector("svg")!
  const q = (sel: string) => r.container.querySelector(sel)!
  return { ...r, svg, q, onCommitStructure }
}

describe("a wall by mouse", () => {
  it("drags a point, snapped to the lattice", () => {
    const { svg, q, onCommitStructure } = draw([wall()], {
      selectedWallId: "w1",
    })
    fireEvent.pointerDown(
      q('[data-handles="run"] [data-vertex="1"]'),
      at(320, 80)
    )
    fireEvent.pointerMove(svg, at(362, 118))
    fireEvent.pointerUp(svg, at(362, 118))
    expect(onCommitStructure).toHaveBeenCalledTimes(1)
    expect(onCommitStructure.mock.calls[0][0].update[0].points).toEqual([
      [2, 2],
      [9, 3],
    ])
  })

  it("drags a segment, its neighbours following", () => {
    const w = wall({
      points: [
        [2, 2],
        [8, 2],
        [8, 6],
      ],
    })
    const { svg, q, onCommitStructure } = draw([w], { selectedWallId: "w1" })
    fireEvent.pointerDown(q('[data-segment-handle="1"]'), at(320, 160))
    fireEvent.pointerMove(svg, at(400, 160))
    fireEvent.pointerUp(svg, at(400, 160))
    expect(onCommitStructure.mock.calls[0][0].update[0].points).toEqual([
      [2, 2],
      [10, 2],
      [10, 6],
    ])
  })

  it("moves the whole run from its body", () => {
    const { svg, q, onCommitStructure } = draw([wall()])
    fireEvent.pointerDown(q('[data-wall="w1"] [data-seg="0"]'), at(200, 80))
    fireEvent.pointerMove(svg, at(200, 160))
    fireEvent.pointerUp(svg, at(200, 160))
    expect(onCommitStructure.mock.calls[0][0].update[0].points).toEqual([
      [2, 4],
      [8, 4],
    ])
  })

  it("a press that does not move is a click: nothing changes", () => {
    const onSelectWall = vi.fn()
    const { svg, q, onCommitStructure } = draw([wall()], { onSelectWall })
    fireEvent.pointerDown(q('[data-wall="w1"] [data-seg="0"]'), at(200, 80))
    fireEvent.pointerUp(svg, at(200, 80))
    expect(onSelectWall).toHaveBeenCalledWith("w1")
    expect(onCommitStructure).not.toHaveBeenCalled()
  })

  it("joins two walls when an end is dropped on the other's end", () => {
    const other = wall({
      id: "w2",
      points: [
        [10, 2],
        [10, 8],
      ],
    })
    const { svg, q, onCommitStructure } = draw([wall(), other], {
      selectedWallId: "w1",
    })
    fireEvent.pointerDown(
      q('[data-handles="run"] [data-vertex="1"]'),
      at(320, 80)
    )
    fireEvent.pointerMove(svg, at(398, 82))
    // A guide line shows nothing here: the point landed on the end itself.
    fireEvent.pointerUp(svg, at(398, 82))
    const c = onCommitStructure.mock.calls[0][0]
    expect(c.remove).toEqual(["w2"])
    expect(c.update[0].points).toEqual([
      [2, 2],
      [10, 2],
      [10, 8],
    ])
  })

  it("Alt keeps the end off the other wall: no join", () => {
    const other = wall({
      id: "w2",
      points: [
        [10, 2],
        [10, 8],
      ],
    })
    const { svg, q, onCommitStructure } = draw([wall(), other], {
      selectedWallId: "w1",
    })
    fireEvent.pointerDown(
      q('[data-handles="run"] [data-vertex="1"]'),
      at(320, 80)
    )
    fireEvent.pointerMove(svg, at(398, 82, { altKey: true }))
    fireEvent.pointerUp(svg, at(398, 82, { altKey: true }))
    const c = onCommitStructure.mock.calls[0][0]
    expect(c.remove).toBeUndefined()
  })

  it("draws a guide while a point lines up with another wall's", () => {
    const other = wall({
      id: "w2",
      points: [
        [12, 6],
        [16, 6],
      ],
    })
    const { container, svg, q } = draw([wall(), other], {
      selectedWallId: "w1",
    })
    fireEvent.pointerDown(
      q('[data-handles="run"] [data-vertex="1"]'),
      at(320, 80)
    )
    fireEvent.pointerMove(svg, at(483, 204))
    const guides = container.querySelectorAll(
      '[data-part="structure-overlay"] line'
    )
    expect(guides.length).toBeGreaterThan(0)
  })

  it("splits on a double-click of a segment", () => {
    const splitAt = vi.fn()
    const { q } = draw([wall()], { structureActions: { splitAt } })
    fireEvent.doubleClick(q('[data-wall="w1"] [data-seg="0"]'), at(200, 80))
    expect(splitAt).toHaveBeenCalledWith("w1", 0, 3)
  })

  it("right-click on a wall lists what can be done there", () => {
    const addDoorAt = vi.fn()
    const { svg } = draw([wall()], {
      structureActions: { addDoorAt, splitAt: vi.fn(), deleteRow: vi.fn() },
    })
    fireEvent.contextMenu(svg, at(200, 80))
    expect(screen.getByText("Split here")).toBeTruthy()
    expect(screen.getByText("Delete wall")).toBeTruthy()
    fireEvent.click(screen.getByText("Add door here"))
    expect(addDoorAt).toHaveBeenCalledWith("w1", 0, 3)
  })
})

describe("doors by mouse", () => {
  it("the Door tool draws one along the wall", () => {
    const onAddDoor = vi.fn()
    const { container, svg, q } = draw([wall()], { doorArmed: true, onAddDoor })
    fireEvent.pointerDown(q('[data-wall="w1"] [data-seg="0"]'), at(120, 80))
    fireEvent.pointerMove(svg, at(200, 84))
    // The width, live, from the plan's scale: 2 cells of 600 mm.
    expect(container.querySelector('[data-part="readout"]')?.textContent).toBe(
      "1.2 m"
    )
    expect(container.querySelector("[data-door-draft]")).toBeTruthy()
    fireEvent.pointerUp(svg, at(200, 84))
    expect(onAddDoor).toHaveBeenCalledWith("w1", 0, 1, 3)
  })

  it("a door's end resizes it, inside its wall", () => {
    const w = wall({ openings: [opening()] })
    const { svg, q, onCommitStructure } = draw([w], {
      selectedWallId: "w1",
      selectedDoor: { wallId: "w1", index: 0 },
    })
    fireEvent.pointerDown(q('[data-door-end="to"]'), at(160, 80))
    fireEvent.pointerMove(svg, at(600, 80))
    fireEvent.pointerUp(svg, at(600, 80))
    expect(onCommitStructure.mock.calls[0][0].update[0].openings).toEqual([
      opening({ to: 6 }),
    ])
  })

  it("a door's middle slides it along the wall", () => {
    const w = wall({ openings: [opening()] })
    const { svg, q, onCommitStructure } = draw([w], {
      selectedWallId: "w1",
      selectedDoor: { wallId: "w1", index: 0 },
    })
    fireEvent.pointerDown(q("[data-door-middle]"), at(140, 80))
    fireEvent.pointerMove(svg, at(180, 80))
    fireEvent.pointerUp(svg, at(180, 80))
    expect(onCommitStructure.mock.calls[0][0].update[0].openings).toEqual([
      opening({ from: 2, to: 3 }),
    ])
  })

  it("the swing handle flips it", () => {
    const flipDoor = vi.fn()
    const w = wall({ openings: [opening({ hinge: "start", side: "left" })] })
    const { q } = draw([w], {
      selectedWallId: "w1",
      selectedDoor: { wallId: "w1", index: 0 },
      structureActions: { flipDoor },
    })
    fireEvent.pointerDown(q("[data-door-flip]"), at(120, 40))
    expect(flipDoor).toHaveBeenCalledWith("w1", 0)
  })

  it("a press on a door picks it", () => {
    const onSelectDoor = vi.fn()
    const w = wall({ openings: [opening()] })
    const { q } = draw([w], { onSelectDoor })
    fireEvent.pointerDown(q('[data-door-hit="0"]'), at(140, 80))
    expect(onSelectDoor).toHaveBeenCalledWith({ wallId: "w1", index: 0 })
  })
})

describe("raised floors by mouse", () => {
  it("moves on whole cells, its edge pulled onto its neighbour's", () => {
    const { svg, q, onCommitStructure } = draw(
      [raised(), raised({ id: "r2", x: 6, width: 2, height: 2 })],
      { selectedAreaId: "r2" }
    )
    fireEvent.pointerDown(q('[data-raised="r2"]'), at(260, 260))
    fireEvent.pointerMove(svg, at(185, 262))
    fireEvent.pointerUp(svg, at(185, 262))
    expect(onCommitStructure.mock.calls[0][0].update[0]).toMatchObject({
      x: 4,
      y: 6,
    })
  })

  it("resizes from a handle", () => {
    const { svg, q, onCommitStructure } = draw([raised()], {
      selectedAreaId: "r1",
    })
    fireEvent.pointerDown(
      q('[data-handles="raised"] [data-handle="se"]'),
      at(160, 400)
    )
    fireEvent.pointerMove(svg, at(240, 440))
    fireEvent.pointerUp(svg, at(240, 440))
    expect(onCommitStructure.mock.calls[0][0].update[0]).toMatchObject({
      width: 6,
      height: 5,
    })
  })

  it("a drop onto another raised floor is refused", () => {
    const { svg, q, onCommitStructure } = draw(
      [raised(), raised({ id: "r2", x: 6, width: 2, height: 2 })],
      { selectedAreaId: "r2" }
    )
    fireEvent.pointerDown(q('[data-raised="r2"]'), at(260, 260))
    fireEvent.pointerMove(svg, at(140, 260))
    fireEvent.pointerUp(svg, at(140, 260))
    expect(onCommitStructure).not.toHaveBeenCalled()
  })
})
