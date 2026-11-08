// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanPlaceable, FloorPlanTile } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import type { FloorCanvasProps } from "./floor-canvas"
import { PLACE_MIME, linkedTile } from "./placement"

// Placing on the 2D plan: rows dropped from the Place picker, a device drawn
// in its role's colour and icon or as its photo, the photo's corner resize
// that keeps its proportions, the free plan's stacking order, and the
// toolbar floating above the selection. jsdom lays nothing out: zoom 1, the
// plan 40 px in, 40 px to a cell.

beforeAll(() => {
  Element.prototype.setPointerCapture = () => {}
})
afterEach(cleanup)

const plan = (layout: "grid" | "free" = "grid") =>
  ({
    id: "p1",
    name: "Hall",
    grid_width: 20,
    grid_height: 12,
    cell_mm: 600,
    ceiling_mm: 3000,
    background_image: null,
    background_opacity: 60,
    state: {},
    layout_mode: layout,
  }) as unknown as FloorPlan

const row: FloorPlanPlaceable = {
  kind: "device",
  id: "d1",
  name: "sw1",
  rank: 0,
  room: null,
  location: null,
  status: null,
  role: { id: "role1", name: "Access", color: "#0ea5e9", icon: "router" },
  photo: null,
  placed_count: 0,
  placed_on: [],
}

const device = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile => ({
  ...linkedTile(row, { x: 2, y: 2, width: 2, height: 1 }, "t1", "icon"),
  ...patch,
})

const photo = {
  url: "/media/sw.png",
  aspect: 0.25,
  source: "type" as const,
  width_mm: 440,
}

function draw(props: Partial<FloorCanvasProps> = {}) {
  const r = render(
    <FloorCanvas
      plan={plan()}
      tiles={[]}
      selectedId={null}
      editable
      showGrid
      armed={null}
      {...props}
    />
  )
  return {
    ...r,
    svg: r.container.querySelector("svg")!,
    root: r.container.querySelector("[data-floor-canvas]")!,
  }
}

/** A drop of `rows` at (x, y) plan pixels. */
function dropAt(el: Element, rows: FloorPlanPlaceable[], x: number, y: number) {
  const data: Record<string, string> = { [PLACE_MIME]: JSON.stringify(rows) }
  const dataTransfer = {
    types: [PLACE_MIME],
    getData: (k: string) => data[k] ?? "",
    dropEffect: "none",
  }
  // jsdom's drag events carry no pointer position: give them one.
  for (const make of [createEvent.dragOver, createEvent.drop]) {
    const ev = make(el, { dataTransfer })
    Object.defineProperty(ev, "clientX", { value: x + 40 })
    Object.defineProperty(ev, "clientY", { value: y + 40 })
    fireEvent(el, ev)
  }
}

describe("dropping rows on the plan", () => {
  it("reports the cell point under the drop", () => {
    const onDropRows = vi.fn()
    const { root } = draw({ onDropRows })
    dropAt(root, [row, { ...row, id: "d2" }], 130, 90)
    expect(onDropRows).toHaveBeenCalledTimes(1)
    const [rows, at] = onDropRows.mock.calls[0]
    expect(rows.map((r: FloorPlanPlaceable) => r.id)).toEqual(["d1", "d2"])
    expect(at).toEqual([3.25, 2.25])
  })

  it("is not a drop target while viewing", () => {
    const { root } = draw({ editable: false })
    // No handler: nothing to call, and no error.
    expect(() => dropAt(root, [row], 10, 10)).not.toThrow()
  })
})

describe("a placed device", () => {
  it("wears its role's colour and icon without a tile type", () => {
    const { container } = draw({ tiles: [device()] })
    const fill = container.querySelector('[data-tile="t1"] [data-part="fill"]')!
    expect(fill.getAttribute("fill")).toBe("#0ea5e9")
    expect(container.querySelector('[data-part="role-icon"]')).not.toBeNull()
  })

  it("follows its role: a new role colour repaints it", () => {
    const { container, rerender } = draw({ tiles: [device()] })
    rerender(
      <FloorCanvas
        plan={plan()}
        tiles={[
          device({
            linked: {
              ...device().linked!,
              role: {
                id: "role1",
                name: "Access",
                color: "#f97316",
                icon: "router",
              },
            },
          }),
        ]}
        selectedId={null}
        editable
        showGrid
        armed={null}
      />
    )
    const fill = container.querySelector('[data-tile="t1"] [data-part="fill"]')!
    expect(fill.getAttribute("fill")).toBe("#f97316")
  })

  it("shows its photo with the aspect kept", () => {
    const { container } = draw({ tiles: [device({ display: "photo", photo })] })
    const img = container.querySelector('[data-part="photo-tile"] image')!
    expect(img.getAttribute("href")).toBe("/media/sw.png")
    expect(img.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet")
  })

  it("falls back to its box without a photo", () => {
    const { container } = draw({
      tiles: [device({ display: "photo", photo: null })],
    })
    expect(container.querySelector('[data-part="photo-tile"]')).toBeNull()
    expect(container.querySelector('[data-part="fill"]')).not.toBeNull()
  })
})

describe("a photo on a free plan", () => {
  it("resizes from a corner keeping its proportions; Shift frees them", () => {
    const onChangeTile = vi.fn()
    const tile = device({
      display: "photo",
      photo,
      x: 2,
      y: 2,
      width: 4,
      height: 1,
    })
    const { container, svg } = draw({
      plan: plan("free"),
      tiles: [tile],
      selectedId: "t1",
      onChangeTile,
    })
    // Corners only.
    expect(container.querySelector('[data-handle="e"]')).toBeNull()
    const se = container.querySelector('[data-handle="se"]')!
    fireEvent.pointerDown(se, {
      pointerId: 1,
      button: 0,
      clientX: 280,
      clientY: 160,
    })
    fireEvent.pointerMove(svg, {
      pointerId: 1,
      clientX: 360,
      clientY: 240,
      altKey: true,
    })
    const kept = onChangeTile.mock.calls.at(-1)![1]
    expect(kept.width / kept.height).toBeCloseTo(4)
    fireEvent.pointerMove(svg, {
      pointerId: 1,
      clientX: 360,
      clientY: 240,
      altKey: true,
      shiftKey: true,
    })
    const freed = onChangeTile.mock.calls.at(-1)![1]
    expect(freed).toMatchObject({ width: 6, height: 3 })
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 360, clientY: 240 })
  })

  it("stacks tiles by z", () => {
    const { container } = draw({
      plan: plan("free"),
      tiles: [
        device({ id: "top", z: 5 }),
        device({ id: "bottom", z: -1, x: 2.5 }),
      ],
    })
    const order = [...container.querySelectorAll("[data-tile]")].map((g) =>
      g.getAttribute("data-tile")
    )
    expect(order).toEqual(["bottom", "top"])
  })
})

describe("the floating toolbar", () => {
  it("sits above the one selected tile, in Edit", () => {
    const { container } = draw({
      tiles: [device()],
      selectedId: "t1",
      selectionToolbar: <button>Tools</button>,
    })
    const bar = container.querySelector(
      '[data-part="selection-toolbar"]'
    ) as HTMLElement
    expect(bar).not.toBeNull()
    // Tile (2..4, 2..3): its top middle, 3 cells in and 2 down, 40 px a
    // cell and 40 px in, 10 px above it.
    expect(bar.style.left).toBe("160px")
    expect(bar.style.top).toBe("110px")
  })

  it("is not shown without a selection or while viewing", () => {
    const tb = <button>Tools</button>
    expect(
      draw({ tiles: [device()], selectionToolbar: tb }).container.querySelector(
        '[data-part="selection-toolbar"]'
      )
    ).toBeNull()
    cleanup()
    expect(
      draw({
        tiles: [device()],
        selectedId: "t1",
        editable: false,
        selectionToolbar: tb,
      }).container.querySelector('[data-part="selection-toolbar"]')
    ).toBeNull()
  })
})
