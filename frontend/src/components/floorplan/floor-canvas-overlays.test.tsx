// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import { planSvg } from "./plan-svg"
import type { LabelShape } from "./shapes"

// The screen-size overlays - grown symbols, icon tiles, their names, the
// labels that open a link - draw over a live view's surround and are never
// clipped to its grid; the plan itself stays clipped. On paper the page's
// frame clips, so icons keep inside it.

vi.mock("@/lib/use-me", () => ({ useMe: () => ({}) }))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)

const plan = (over: Partial<FloorPlan> = {}) =>
  ({
    id: "v1",
    name: "Server room A",
    grid_width: 12,
    grid_height: 8,
    cell_mm: 600,
    ceiling_mm: 3000,
    background_image: null,
    background_opacity: 60,
    state: {},
    ...over,
  }) as unknown as FloorPlan

const tile = (
  id: string,
  x: number,
  y: number,
  over: Partial<FloorPlanTile> = {}
): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "#2563eb",
    status: "",
    linked: { kind: "rack", id: `r-${id}`, name: `R-${id}`, route: "/r" },
    fov_anchor: "",
    fov_ptz: false,
    ...over,
  }) as unknown as FloorPlanTile

const label = (patch: Partial<LabelShape> = {}): LabelShape => ({
  kind: "label",
  id: "l1",
  text: "Back to the campus",
  x: 0,
  y: 0,
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

const opens = {
  id: "c1",
  name: "Campus",
  stack_name: "Campus",
  kind: "plan" as const,
  can_change: true,
}

function drawView() {
  const r = render(
    <FloorCanvas
      plan={plan()}
      tiles={[tile("a03", 0, 3), tile("a05", 0.2, 3.4), tile("b", 6, 4)]}
      selectedId={null}
      editable={false}
      showGrid={false}
      armed={null}
      iconTiles
      clipToGrid
      maskOutline={[
        [1, 1],
        [11, 1],
        [11, 7],
        [1, 7],
      ]}
      shapes={[label({ opens }), label({ id: "l2", text: "Row A", y: 5 })]}
    />
  )
  act(() => {
    fireEvent.wheel(r.container.querySelector("svg")!, { deltaY: 3000 })
  })
  return r
}

const clipped = (el: Element | null) => !!el?.closest("[clip-path]")

describe("the overlays on a live view", () => {
  it("draw over the surround, the plan under it clipped", () => {
    const { container } = drawView()
    const mask = container.querySelector('[data-part="area-mask"]')!
    const over = container.querySelector('[data-layer="overlays"]')!
    expect(mask).toBeTruthy()
    expect(over).toBeTruthy()
    expect(clipped(mask)).toBe(true)
    // After the surround in document order: on top of it.
    expect(
      mask.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(over.querySelector('[data-layer="icon-tiles"]')).toBeTruthy()
    expect(over.querySelector('[data-layer="grown-tiles"]')).toBeTruthy()
  })

  it("never clip the icon tiles", () => {
    const { container } = drawView()
    const over = container.querySelector('[data-layer="overlays"]')!
    expect(over.hasAttribute("clip-path")).toBe(false)
    expect(clipped(over)).toBe(false)
    const icons = container.querySelectorAll("[data-icon-tile]")
    expect(icons.length).toBeGreaterThan(0)
    for (const el of icons) {
      expect(over.contains(el)).toBe(true)
      expect(clipped(el)).toBe(false)
    }
  })

  it("never covers or clips a label that opens a link", () => {
    const { container } = drawView()
    const over = container.querySelector('[data-layer="overlays"]')!
    const back = container.querySelector('[data-label="l1"]')!
    const plain = container.querySelector('[data-label="l2"]')!
    expect(over.contains(back)).toBe(true)
    expect(clipped(back)).toBe(false)
    // A plain label stays clipped with the plan.
    expect(clipped(plain)).toBe(true)
  })
})

describe("icons on paper", () => {
  const big = plan({ id: "p1", grid_width: 512, grid_height: 266 })

  /** Each printed icon's box and the drawing's view box (plan px). */
  function icons(svg: string) {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
    const [x, y, w, h] = doc.documentElement
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number)
    const boxes = [...doc.querySelectorAll("[data-icon-tile]")].map((r) => ({
      x: Number(r.getAttribute("x")),
      y: Number(r.getAttribute("y")),
      w: Number(r.getAttribute("width")),
      h: Number(r.getAttribute("height")),
    }))
    return { vb: { x, y, w, h }, boxes }
  }

  const insideOf = (
    vb: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ) =>
    b.x >= vb.x - 0.01 &&
    b.y >= vb.y - 0.01 &&
    b.x + b.w <= vb.x + vb.w + 0.01 &&
    b.y + b.h <= vb.y + vb.h + 0.01

  it("keeps icons by the plan's edge inside the page", () => {
    const { vb, boxes } = icons(
      planSvg({
        plan: big,
        tiles: [tile("a", 0, 100), tile("b", 0.5, 100.3)],
        iconTiles: true,
      })
    )
    expect(boxes.length).toBeGreaterThan(0)
    for (const b of boxes) expect(insideOf(vb, b)).toBe(true)
  })

  it("keeps icons inside a drawing framed to its content", () => {
    const { vb, boxes } = icons(
      planSvg({
        plan: big,
        tiles: [
          tile("a", 10, 100),
          tile("b", 10.5, 100.3),
          tile("c", 400, 200),
        ],
        iconTiles: true,
        fitContent: { paper: { size: "a3", orientation: "landscape" } },
      })
    )
    expect(vb.x).toBeGreaterThan(0)
    expect(boxes.length).toBeGreaterThan(0)
    for (const b of boxes) expect(insideOf(vb, b)).toBe(true)
  })
})
