// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"
import { FloorCanvas } from "./floor-canvas"
import type { FloorCanvasProps } from "./floor-canvas"
import type { AreaShape, LabelShape } from "./shapes"

// Opens links on the 2D plan - a link mark on the shape, a hint naming the
// target in View, a viewer's click on a label that opens - and the
// right-click menu on empty plan space. jsdom lays nothing out: zoom 1,
// 40 px in, 40 px to a cell.

beforeAll(() => {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
})
afterEach(cleanup)

const plan = {
  id: "p1",
  name: "Site",
  grid_width: 20,
  grid_height: 12,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
  layout_mode: "grid",
} as unknown as FloorPlan

const opens = {
  id: "b1",
  name: "B1",
  stack_name: "Campus",
  kind: "plan" as const,
  can_change: true,
}

const area = (patch: Partial<AreaShape> = {}): AreaShape => ({
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 2,
  y: 2,
  width: 4,
  height: 3,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "Yard",
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
  text: "Go to B1",
  x: 8,
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
      mode="layout"
      {...props}
    />
  )
  return { ...r, svg: r.container.querySelector("svg")! }
}

describe("an Opens link", () => {
  it("marks the area and the label", () => {
    const { container } = draw({
      shapes: [area({ opens }), label({ opens }), label({ id: "l2", y: 6 })],
    })
    expect(
      container.querySelector('[data-area="a1"] [data-part="opens-mark"]')
    ).toBeTruthy()
    expect(
      container.querySelector('[data-label="l1"] [data-part="opens-mark"]')
    ).toBeTruthy()
    expect(
      container.querySelector('[data-label="l2"] [data-part="opens-mark"]')
    ).toBeNull()
  })

  it("names its target on hover in View", () => {
    const { svg } = draw({ editable: false, shapes: [area({ opens })] })
    fireEvent.pointerMove(svg, at(120, 100))
    expect(screen.getByText("Opens Campus · B1")).toBeTruthy()
    fireEvent.pointerMove(svg, at(600, 400))
    expect(screen.queryByText("Opens Campus · B1")).toBeNull()
  })

  it("a viewer's click on a linked label opens it; a plain label is inert", () => {
    const onOpenShape = vi.fn()
    const { container, svg } = draw({
      editable: false,
      shapes: [label({ opens }), label({ id: "l2", y: 6 })],
      onOpenShape,
    })
    const linked = container.querySelector('[data-label="l1"]') as SVGGElement
    expect(linked.style.pointerEvents).toBe("auto")
    expect(linked.style.cursor).toBe("pointer")
    fireEvent.pointerDown(linked, at(330, 50))
    fireEvent.pointerUp(svg, at(330, 50))
    expect(onOpenShape).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l1" })
    )
    const plain = container.querySelector('[data-label="l2"]') as SVGGElement
    expect(plain.style.pointerEvents).toBe("none")
  })
})

describe("right-click on empty plan space", () => {
  it("offers place, draw and label at the point in Edit", async () => {
    const placeAt = vi.fn()
    const drawAreaAt = vi.fn()
    const addLabelAt = vi.fn()
    const { svg } = draw({
      emptyActions: { placeAt, drawAreaAt, addLabelAt },
    })
    fireEvent.contextMenu(svg, { clientX: 40 + 200, clientY: 40 + 120 })
    expect(await screen.findByText("Draw room/area here")).toBeTruthy()
    expect(screen.getByText("Add label here")).toBeTruthy()
    expect(screen.queryByText("Paste")).toBeNull()
    expect(screen.queryByText("Edit here")).toBeNull()
    fireEvent.click(screen.getByText("Place device here…"))
    expect(placeAt).toHaveBeenCalledWith([5, 3])
  })

  it("adds a label at the point", async () => {
    const addLabelAt = vi.fn()
    const { svg } = draw({ emptyActions: { addLabelAt } })
    fireEvent.contextMenu(svg, { clientX: 40 + 100, clientY: 40 + 60 })
    fireEvent.click(await screen.findByText("Add label here"))
    expect(addLabelAt).toHaveBeenCalledWith([2.5, 1.5])
  })

  it("offers Edit here in View", async () => {
    const editHere = vi.fn()
    const { svg } = draw({ editable: false, emptyActions: { editHere } })
    fireEvent.contextMenu(svg, { clientX: 60, clientY: 60 })
    fireEvent.click(await screen.findByText("Edit here"))
    expect(editHere).toHaveBeenCalled()
    expect(screen.queryByText("Place device here…")).toBeNull()
  })
})
