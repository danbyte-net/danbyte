// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import { FloorCanvas } from "./floor-canvas"

// A tile linked to a DIN-rail cabinet on the 2D plan: named after the
// cabinet unless labelled, its device count from the live state in its
// corner, and its border red the moment one of its devices goes down - the
// same read a rack tile gives.

afterEach(cleanup)

const plan = {
  id: "p1",
  name: "Serverrum A",
  grid_width: 12,
  grid_height: 8,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
} as unknown as FloorPlan

const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile => ({
  id: "t1",
  x: 2,
  y: 2,
  width: 3,
  height: 1,
  orientation: 0,
  tile_type: {
    id: "tt1",
    name: "Cabinet",
    slug: "cabinet",
    color: "#64748b",
    icon: "",
    default_width: 1,
    default_height: 1,
    is_zone: false,
    has_fov: false,
  },
  role_type: null,
  label: "",
  color: "",
  status: "",
  link_kind: "cabinet",
  linked: { kind: "cabinet", id: "c1", name: "K1", route: "/cabinets/c1" },
  fov_deg: null,
  fov_distance: null,
  fov_direction: null,
  fov_anchor: "",
  fov_ptz: false,
  created_at: "",
  updated_at: "",
  ...patch,
})

const live = (
  check: "up" | "down" | null,
  devices = 5
): FloorPlanLiveState => ({
  as_of: "",
  tiles: {
    t1: { kind: "cabinet", device_count: devices, rail_count: 2, check },
  },
})

function draw(t: FloorPlanTile, state: FloorPlanLiveState | null) {
  return render(
    <FloorCanvas
      plan={plan}
      tiles={[t]}
      selectedId={null}
      editable={false}
      showGrid
      armed={null}
      liveState={state}
    />
  )
}

/** The tile's own group - the one the canvas names for screen readers. */
const tileGroup = (c: HTMLElement) =>
  c.querySelector<SVGGElement>('g[role="img"]')!

describe("a cabinet tile", () => {
  it("is named after its cabinet, unless labelled", () => {
    const { container } = draw(tile(), live("up"))
    expect(tileGroup(container).textContent).toContain("K1")
    cleanup()
    const labelled = draw(tile({ label: "North" }), live("up"))
    const g = tileGroup(labelled.container)
    expect(g.textContent).toContain("North")
    expect(g.textContent).not.toContain("K1")
  })

  it("counts its devices in the corner", () => {
    const { container } = draw(tile(), live("up", 5))
    const count = container.querySelector('[data-part="device-count"]')
    expect(count?.textContent).toBe("5")
    expect(count?.querySelector("svg.lucide-server")).toBeTruthy()
    expect(tileGroup(container).getAttribute("aria-label")).toContain(
      "5 devices, 2 rails"
    )
  })

  it("counts nothing before the live state lands", () => {
    const { container } = draw(tile(), null)
    expect(container.querySelector('[data-part="device-count"]')).toBeNull()
  })

  it("turns its border red when a device is down", () => {
    const up = draw(tile(), live("up"))
    const calm = tileGroup(up.container).querySelector("rect")!
    expect(calm.getAttribute("stroke")).toBe("#64748b")
    cleanup()
    const down = draw(tile(), live("down"))
    const red = tileGroup(down.container).querySelector("rect")!
    expect(red.getAttribute("stroke")).toBe("#ef4444")
    expect(red.getAttribute("stroke-width")).toBe("2")
  })

  it("draws no utilization bar - a cabinet has no units", () => {
    const { container } = draw(tile(), live("up"))
    expect(tileGroup(container).textContent).not.toContain("%")
  })
})

// #247: Color by. A rack's level fills its tile, monitoring keeps the
// outline, and the figure is written on the tile - a one-cell tile too.
describe("a rack tile coloured by a measure", () => {
  const rackTile = tile({
    width: 1,
    height: 1,
    link_kind: "rack",
    linked: { kind: "rack", id: "r1", name: "A01", route: "/racks/r1" },
  })
  const rackLive = (
    used_units: number,
    check: "down" | null = null
  ): FloorPlanLiveState => ({
    as_of: "",
    tiles: {
      t1: {
        kind: "rack",
        used_units,
        u_height: 42,
        power: { available_w: 0, allocated_w: 0, maximum_w: 0 },
        total_weight_kg: 0,
        max_weight_kg: null,
        device_count: 3,
        check,
      },
    },
  })
  const paint = (
    colorBy: "type" | "space" | "power",
    state: FloorPlanLiveState,
    extra: { highlighted?: boolean; dimmed?: boolean } = {}
  ) =>
    render(
      <FloorCanvas
        plan={plan}
        tiles={[rackTile]}
        selectedId={null}
        editable={false}
        showGrid
        armed={null}
        liveState={state}
        colorBy={colorBy}
        highlightTileIds={extra.highlighted ? new Set(["t1"]) : undefined}
        dimTileIds={extra.dimmed ? new Set(["t1"]) : undefined}
      />
    ).container
  const fill = (c: HTMLElement) => c.querySelector('[data-part="fill"]')!

  it("fills it with the level and writes the figure on one cell", () => {
    const c = paint("space", rackLive(40))
    expect(fill(c).getAttribute("fill")).toBe("#ef4444")
    expect(c.querySelector('[data-part="figure"]')?.textContent).toBe("95%")
    cleanup()
    // Under Type a one-cell rack keeps today's look: no figure text.
    const plain = paint("type", rackLive(40))
    expect(fill(plain).getAttribute("fill")).toBe("#64748b")
    expect(plain.querySelector('[data-part="figure"]')?.textContent).toBe("")
  })

  it("says No data where there is nothing to measure", () => {
    const c = paint("power", rackLive(10))
    expect(fill(c).getAttribute("fill")).toBe("#a1a1aa")
    expect(c.querySelector('[data-part="figure"]')?.textContent).toBe("No data")
  })

  it("keeps the monitoring outline over the level's fill", () => {
    const c = paint("space", rackLive(10, "down"))
    expect(fill(c).getAttribute("fill")).toBe("#10b981")
    expect(fill(c).getAttribute("stroke")).toBe("#ef4444")
  })

  it("rings the rack a table row points at, and fades one it filters out", () => {
    const pointed = paint("space", rackLive(10), { highlighted: true })
    expect(pointed.querySelector('[data-part="highlight"]')).toBeTruthy()
    cleanup()
    const faded = paint("space", rackLive(10), { dimmed: true })
    expect(tileGroup(faded).getAttribute("opacity")).toBe("0.25")
    expect(faded.querySelector('[data-part="highlight"]')).toBeNull()
  })
})

// Drawing calibration: in point-pick mode a click reports its world point
// and nothing under it is opened or selected; the drawing sits under the
// grid.
describe("point-pick mode and the drawing underlay", () => {
  it("reports a click's world point instead of opening the tile", () => {
    const onPick = vi.fn()
    const onOpen = vi.fn()
    const { container } = render(
      <FloorCanvas
        plan={plan}
        tiles={[tile()]}
        selectedId={null}
        editable={false}
        showGrid
        armed={null}
        onOpenTile={onOpen}
        onPickPoint={onPick}
      />
    )
    const svg = container.querySelector("svg")!
    svg.setPointerCapture = () => {}
    const g = tileGroup(container)
    fireEvent.pointerDown(g, { button: 0, clientX: 140, clientY: 90 })
    fireEvent.pointerUp(g, { button: 0, clientX: 140, clientY: 90 })
    expect(onOpen).not.toHaveBeenCalled()
    // The default view is translated by (40, 40) at zoom 1.
    expect(onPick).toHaveBeenCalledWith({ x: 100, y: 50 })
  })

  it("draws the underlay before the grid", () => {
    const { container } = render(
      <FloorCanvas
        plan={plan}
        tiles={[]}
        selectedId={null}
        editable={false}
        showGrid
        armed={null}
        underlay={<g data-testid="under" />}
      />
    )
    const under = container.querySelector('[data-testid="under"]')!
    const grid = container.querySelector('rect[fill="url(#fp-grid)"]')!
    expect(
      under.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

// Working a selection: Shift- or Ctrl/⌘-click grows it, dragging one of
// its tiles moves all of it by whole cells (one gesture, one undo step),
// and a press that never moves is a plain click on that tile.
describe("a multi-selection", () => {
  const two = [
    tile({ id: "t1", x: 2, y: 2, width: 1, height: 1, linked: null }),
    tile({ id: "t2", x: 4, y: 2, width: 1, height: 1, linked: null }),
  ]
  const setup = () => {
    Element.prototype.setPointerCapture = () => {}
    const props = {
      onSelect: vi.fn(),
      onToggleSelect: vi.fn(),
      onMoveSelection: vi.fn((_dx: number, _dy: number) => true),
      onGestureStart: vi.fn(),
      onGestureEnd: vi.fn(),
    }
    const { container } = render(
      <FloorCanvas
        plan={plan}
        tiles={two}
        selectedId={null}
        editable
        showGrid
        armed={null}
        multiSelectedIds={new Set(["t1", "t2"])}
        {...props}
      />
    )
    const svg = container.querySelector("svg")!
    const first = container.querySelector<SVGGElement>('g[data-tile="t1"]')!
    return { props, svg, first }
  }
  // The default view is translated by (40, 40) at zoom 1: cell (x, y) is
  // at client 40 + 40x.
  const at = (x: number, y: number) => ({
    button: 0,
    clientX: 45 + 40 * x,
    clientY: 45 + 40 * y,
  })

  it("Shift-click toggles a tile instead of moving it", () => {
    const { props, first } = setup()
    fireEvent.pointerDown(first, { ...at(2, 2), shiftKey: true })
    expect(props.onToggleSelect).toHaveBeenCalledWith("t1")
    expect(props.onGestureStart).not.toHaveBeenCalled()
  })

  it("dragging one of its tiles moves the whole selection", () => {
    const { props, svg, first } = setup()
    fireEvent.pointerDown(first, at(2, 2))
    fireEvent.pointerMove(svg, at(3, 4))
    fireEvent.pointerMove(svg, at(3, 4))
    fireEvent.pointerUp(svg, at(3, 4))
    expect(props.onGestureStart).toHaveBeenCalledTimes(1)
    expect(props.onMoveSelection).toHaveBeenCalledTimes(1)
    expect(props.onMoveSelection).toHaveBeenCalledWith(1, 2)
    expect(props.onGestureEnd).toHaveBeenCalledTimes(1)
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it("a refused step waits and the next one catches up", () => {
    const { props, svg, first } = setup()
    props.onMoveSelection.mockReturnValueOnce(false)
    fireEvent.pointerDown(first, at(2, 2))
    fireEvent.pointerMove(svg, at(3, 2))
    fireEvent.pointerMove(svg, at(4, 2))
    expect(props.onMoveSelection.mock.calls).toEqual([
      [1, 0],
      [2, 0],
    ])
  })

  it("a press without a move is a plain click on that tile", () => {
    const { props, svg, first } = setup()
    fireEvent.pointerDown(first, at(2, 2))
    fireEvent.pointerUp(svg, at(2, 2))
    expect(props.onMoveSelection).not.toHaveBeenCalled()
    expect(props.onSelect).toHaveBeenCalledWith("t1")
  })
})
