// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import type { FloorCanvasProps } from "./floor-canvas"
import type { AreaShape } from "./shapes"

// Click to zoom and the plan's filter on the canvas. The svg is 800 x 600
// here (jsdom lays nothing out, so its rect is stubbed) and motion is
// reduced, so a zoom lands at once. 10 m cells: the overview.

vi.mock("@/lib/use-me", () => ({ useMe: () => ({}) }))
const rect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      toJSON() {},
    } as DOMRect
  }
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = rect
})
afterEach(cleanup)

const plan = (cellMm = 10000) =>
  ({
    id: "p1",
    name: "Campus",
    grid_width: 100,
    grid_height: 80,
    cell_mm: cellMm,
    ceiling_mm: 3000,
    background_image: null,
    background_opacity: 60,
    state: {},
    layout_mode: "grid",
  }) as unknown as FloorPlan

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

const building = area("Building A", { x: 10, y: 10, width: 20, height: 40 })

const AP = { id: "ap", name: "AP", color: "#0ea5e9", icon: "wifi" }
const tileAt = (id: string, x: number, role = AP): FloorPlanTile =>
  ({
    id,
    x,
    y: 20,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "",
    status: "",
    linked: { kind: "device", id: `d-${id}`, name: id, role },
    fov_anchor: "",
    fov_ptz: false,
  }) as unknown as FloorPlanTile
const SRV = { id: "srv", name: "Server", color: "#6366f1", icon: "server" }
const tiles = [tileAt("ap1", 12), tileAt("ap2", 20), tileAt("srv1", 25, SRV)]

function draw(props: Partial<FloorCanvasProps> = {}, cellMm = 10000) {
  return render(
    <FloorCanvas
      plan={plan(cellMm)}
      tiles={tiles}
      shapes={[building]}
      selectedId={null}
      editable={false}
      showGrid={false}
      armed={null}
      detail="auto"
      {...props}
    />
  ).container
}

const zoomOf = (c: Element) => {
  const tr = c
    .querySelector("[data-layer=overlays]")!
    .getAttribute("transform")!
  return Number(/scale\(([\d.e-]+)\)/.exec(tr)![1])
}

/** A still press on the area: a click. */
function click(c: Element, id: string, at = { clientX: 300, clientY: 300 }) {
  const g = c.querySelector(`[data-area="${id}"]`)!
  fireEvent.pointerDown(g, { button: 0, ...at })
  fireEvent.pointerUp(c.querySelector("svg")!, { button: 0, ...at })
}

describe("click to zoom", () => {
  it("zooms a room clicked from afar to fit it, then in to the room level", () => {
    const onOpenShape = vi.fn()
    const c = draw({ onOpenShape })
    const before = zoomOf(c)
    click(c, "Building A")
    // 40 cells tall in 536 px.
    expect(zoomOf(c)).toBeGreaterThan(before)
    expect(zoomOf(c)).toBeCloseTo(536 / (40 * 40), 3)
    // Fitted, still the overview at 10 m cells: the next click goes in to
    // the room level (12.65 px a metre: k 3.16).
    click(c, "Building A")
    expect(zoomOf(c)).toBeCloseTo((11 * 1.15 * 10000) / 1000 / 40, 2)
    expect(onOpenShape).not.toHaveBeenCalled()
  })

  it("opens the area as before while editing", () => {
    const c = draw({ editable: true, onSelectShape: vi.fn() })
    const before = zoomOf(c)
    click(c, "Building A")
    expect(zoomOf(c)).toBe(before)
  })

  it("keeps Opens apart: its mark opens, a plain click zooms", () => {
    const onOpenShape = vi.fn()
    const linked = {
      ...building,
      opens: { id: "b1", name: "B1", kind: "plan", can_change: true },
    } as unknown as AreaShape
    const c = draw({ onOpenShape, shapes: [linked] })
    const mark = c.querySelector('[data-part="opens-button"]')!
    expect(mark).not.toBeNull()
    fireEvent.click(mark)
    expect(onOpenShape).toHaveBeenCalledWith(linked)
    onOpenShape.mockClear()
    click(c, "Building A")
    expect(onOpenShape).not.toHaveBeenCalled()
  })

  it("lets a key zoom to a focused room", () => {
    const c = draw()
    const g = c.querySelector('[data-area="Building A"]') as HTMLElement
    expect(g.getAttribute("tabindex")).toBe("0")
    const before = zoomOf(c)
    fireEvent.keyDown(g, { key: "Enter" })
    expect(zoomOf(c)).toBeGreaterThan(before)
  })

  it("fits the whole plan again on 0, and on a double-click on empty plan", () => {
    const c = draw()
    const fit = zoomOf(c)
    click(c, "Building A")
    expect(zoomOf(c)).not.toBe(fit)
    act(() => {
      fireEvent.keyDown(window, { key: "0" })
    })
    expect(zoomOf(c)).toBe(fit)
    click(c, "Building A")
    fireEvent.doubleClick(c.querySelector("svg")!)
    expect(zoomOf(c)).toBe(fit)
  })
})

describe("the plan's filter", () => {
  it("draws what it keeps from afar, and only that, with the facts counting it", () => {
    const c = draw({
      filterIds: new Set(["ap1", "ap2"]),
      filterFactKey: (t) => `type:${t.linked?.role?.name}`,
    })
    const drawn = [...c.querySelectorAll("[data-tile]")].map((e) =>
      e.getAttribute("data-tile")
    )
    expect(drawn.sort()).toEqual(["ap1", "ap2"])
    expect(
      c.querySelector('[data-room-label="Building A"] [data-part=room-facts]')
        ?.textContent
    ).toBe("2 APs")
  })

  it("draws nothing of the tiles from afar without one", () => {
    const c = draw()
    expect(c.querySelectorAll("[data-tile]")).toHaveLength(0)
  })

  it("dims the rest up close, or hides it", () => {
    const dim = draw({ filterIds: new Set(["ap1"]) }, 600)
    const rest = dim.querySelector('[data-tile="srv1"]')
    expect(rest).not.toBeNull()
    expect(
      rest!.closest("[data-dimmed],[data-recedes]") ??
        rest!.querySelector("[data-dimmed],[data-recedes]")
    ).not.toBeNull()
    cleanup()
    const hide = draw({ filterIds: new Set(["ap1"]), filterHide: true }, 600)
    expect(hide.querySelector('[data-tile="srv1"]')).toBeNull()
    expect(hide.querySelector('[data-tile="ap1"]')).not.toBeNull()
  })

  it("fades the areas its area type leaves out", () => {
    const c = draw({ filterIds: new Set(), filterAreaIds: new Set() }, 600)
    const g = c.querySelector('[data-area="Building A"]') as HTMLElement
    expect(g.style.opacity).toBe("0.35")
  })
})
