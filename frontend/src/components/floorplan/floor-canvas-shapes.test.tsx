// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"
import { FloorCanvas } from "./floor-canvas"
import type { FloorCanvasProps } from "./floor-canvas"
import type { AreaShape, LabelShape } from "./shapes"

// Rooms, areas and labels on the 2D plan: drawing a rectangle or a polygon
// with its tool, the handles that resize and turn a selected area, a label
// at its real size, and an area clicked while viewing. jsdom lays nothing
// out, so the plan sits at zoom 1, 40 px in: 40 px to a cell.

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

const area = (patch: Partial<AreaShape> = {}): AreaShape => ({
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 2,
  y: 2,
  width: 3,
  height: 2,
  rotation: 0,
  points: [],
  room: { id: "r1", name: "Room 210", code: "210", color: "#0ea5e9" },
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
})

const label = (patch: Partial<LabelShape> = {}): LabelShape => ({
  kind: "label",
  id: "l1",
  text: "North side",
  x: 1,
  y: 1,
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
})

/** A pointer at (x, y) plan pixels. */
const at = (x: number, y: number) => ({
  pointerId: 1,
  button: 0,
  clientX: x + 40,
  clientY: y + 40,
})

function draw(props: Partial<FloorCanvasProps> = {}) {
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={[]}
      selectedId={null}
      editable
      showGrid
      armed={null}
      {...props}
    />
  )
  return { ...r, svg: r.container.querySelector("svg")! }
}

describe("drawing an area", () => {
  it("drags a rectangle with the Room tool", () => {
    const onCreateArea = vi.fn()
    const { svg } = draw({ shapeTool: "rect", onCreateArea })
    fireEvent.pointerDown(svg, at(80, 80))
    fireEvent.pointerMove(svg, at(200, 160))
    fireEvent.pointerUp(svg, at(200, 160))
    expect(onCreateArea).toHaveBeenCalledWith({
      shape: "rect",
      x: 2,
      y: 2,
      width: 3,
      height: 2,
    })
  })

  it("settles a grid plan's corners on half cells", () => {
    const onCreateArea = vi.fn()
    const { svg } = draw({ shapeTool: "rect", onCreateArea })
    fireEvent.pointerDown(svg, at(83, 77))
    fireEvent.pointerMove(svg, at(203, 157))
    fireEvent.pointerUp(svg, at(203, 157))
    expect(onCreateArea).toHaveBeenCalledWith({
      shape: "rect",
      x: 2,
      y: 2,
      width: 3,
      height: 2,
    })
  })

  it("clicks out a polygon and closes it on its first point", () => {
    const onCreateArea = vi.fn()
    const { svg } = draw({ shapeTool: "polygon", onCreateArea })
    for (const [x, y] of [
      [40, 40],
      [200, 40],
      [200, 160],
      [40, 40],
    ])
      fireEvent.pointerDown(svg, at(x, y))
    expect(onCreateArea).toHaveBeenCalledWith({
      shape: "polygon",
      points: [
        [1, 1],
        [5, 1],
        [5, 4],
      ],
    })
  })

  it("places a label with a click of the Label tool", () => {
    const onCreateLabel = vi.fn()
    const { svg } = draw({ shapeTool: "label", onCreateLabel })
    fireEvent.pointerDown(svg, at(120, 80))
    expect(onCreateLabel).toHaveBeenCalledWith({ x: 3, y: 2 })
  })
})

describe("a selected area", () => {
  it("resizes from a corner handle", () => {
    const onChangeShape = vi.fn()
    const onGestureStart = vi.fn()
    const onGestureEnd = vi.fn()
    const { container, svg } = draw({
      shapes: [area()],
      selectedShapeId: "a1",
      onChangeShape,
      onGestureStart,
      onGestureEnd,
    })
    const se = container.querySelector('[data-handle="se"]')!
    fireEvent.pointerDown(se, at(200, 160))
    fireEvent.pointerMove(svg, at(240, 200))
    fireEvent.pointerUp(svg, at(240, 200))
    expect(onChangeShape).toHaveBeenLastCalledWith("a1", {
      x: 2,
      y: 2,
      width: 4,
      height: 3,
    })
    // One drag, one undo step.
    expect(onGestureStart).toHaveBeenCalledTimes(1)
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })

  it("turns with the rotate handle, settling on a quarter turn", () => {
    const onChangeShape = vi.fn()
    const { container, svg } = draw({
      shapes: [area()],
      selectedShapeId: "a1",
      onChangeShape,
    })
    const rot = container.querySelector('[data-handle="rotate"]')!
    fireEvent.pointerDown(rot, at(140, 60))
    // Straight right of the centre (3.5, 3 cells), a hair off: 90°.
    fireEvent.pointerMove(svg, at(300, 123))
    expect(onChangeShape).toHaveBeenLastCalledWith("a1", { rotation: 90 })
    // Shift turns in 15° steps.
    fireEvent.pointerMove(svg, { ...at(240, 220), shiftKey: true })
    expect(onChangeShape).toHaveBeenLastCalledWith("a1", { rotation: 135 })
  })

  it("moves with a drag, once selected", () => {
    const onChangeShape = vi.fn()
    const { container, svg } = draw({
      shapes: [area()],
      selectedShapeId: "a1",
      onChangeShape,
    })
    const g = container.querySelector('[data-area="a1"]')!
    fireEvent.pointerDown(g, at(120, 100))
    fireEvent.pointerMove(svg, at(160, 140))
    fireEvent.pointerUp(svg, at(160, 140))
    expect(onChangeShape).toHaveBeenLastCalledWith("a1", { x: 3, y: 3 })
  })

  it("takes its colour from its room and shows the room's name", () => {
    const { container } = draw({ shapes: [area()] })
    const g = container.querySelector('[data-area="a1"]')!
    expect(g.querySelector("rect")!.getAttribute("fill")).toBe("#0ea5e9")
    expect(g.textContent).toBe("Room 210")
  })
})

describe("labels", () => {
  it("draw at their size in millimetres", () => {
    // 300 mm on a 600 mm cell: half a cell, 20 px at zoom 1.
    const { container } = draw({ shapes: [label()] })
    const text = container.querySelector('[data-label="l1"] text')!
    expect(text.getAttribute("font-size")).toBe("20")
    expect(text.textContent).toBe("North side")
  })

  it("scale their text from a corner handle", () => {
    const onChangeShape = vi.fn()
    const { container, svg } = draw({
      shapes: [label()],
      selectedShapeId: "l1",
      onChangeShape,
    })
    expect(container.querySelector('[data-handle="n"]')).toBeNull()
    const se = container.querySelector('[data-handle="se"]')!
    fireEvent.pointerDown(se, at(168, 71))
    // Down and right well past the corner: the text grows.
    fireEvent.pointerMove(svg, at(240, 120))
    const patch = onChangeShape.mock.lastCall![1] as { font_mm: number }
    expect(patch.font_mm).toBeGreaterThan(300)
  })
})

describe("viewing", () => {
  it("opens an area's room on a click, not on a drag", () => {
    const onOpenShape = vi.fn()
    const { container, svg } = draw({
      editable: false,
      shapes: [area()],
      onOpenShape,
    })
    const g = container.querySelector('[data-area="a1"]')!
    fireEvent.pointerDown(g, at(120, 100))
    fireEvent.pointerUp(svg, at(121, 100))
    expect(onOpenShape).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1" })
    )
    onOpenShape.mockClear()
    fireEvent.pointerDown(g, at(120, 100))
    fireEvent.pointerMove(svg, at(200, 160))
    fireEvent.pointerUp(svg, at(200, 160))
    expect(onOpenShape).not.toHaveBeenCalled()
  })

  it("shows no handles", () => {
    const { container } = draw({
      editable: false,
      shapes: [area()],
      selectedShapeId: "a1",
    })
    expect(container.querySelector("[data-handle]")).toBeNull()
  })
})
