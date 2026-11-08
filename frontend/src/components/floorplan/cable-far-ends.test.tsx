// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanCablePath, FloorPlanTile } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import {
  CableRouteCache,
  MIN_TILE_PX,
  cableCounts,
  cableLegend,
  cableStubs,
  farEndLines,
  shortRuns,
  stubPlaceIds,
  tileMarkerCells,
} from "./cable-draw"
import { CableLayer } from "./cable-layer"
import { CableLegend } from "./cable-legend"
import { CablePopover } from "./cable-popover"
import { planSvg } from "./plan-svg"
import { TileMarkers } from "./tile-layer"

// Cables on a large plan seen from afar: tiles keep a marker where they
// would shrink to a dot, runs too short to see draw as a marker, a cable
// with one end here draws as a stub naming its far end (Hidden masked),
// the legend counts drawn / one end here / not placed, and the export
// draws the stubs too.

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)

const tile = (
  id: string,
  x: number,
  y: number,
  patch: Partial<FloorPlanTile> = {}
): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 1,
    orientation: 0,
    label: "",
    color: "#2563eb",
    status: "",
    linked: { kind: "device", id: `dev-${id}`, name: id },
    tile_type: null,
    role_type: null,
    ...patch,
  }) as FloorPlanTile

// A 512 x 266 site: two devices side by side near the middle, one at the
// east edge.
const plan = { grid_width: 512, grid_height: 266, cell_mm: 1187 }
const tiles = [tile("d1", 300, 130), tile("d2", 301, 130), tile("e", 500, 130)]
const centre: [number, number] = [256, 133]

const cable = (
  id: string,
  patch: Partial<FloorPlanCablePath> = {}
): FloorPlanCablePath => ({
  id,
  label: `C-${id}`,
  color: "",
  type: "cat6",
  a_tiles: [],
  b_tiles: [],
  a_points: [],
  b_points: [],
  tray_ids: [],
  ...patch,
})

const both = cable("both", {
  a_tiles: ["d1"],
  b_tiles: ["d2"],
  a_points: [{ device: "x1", port: "e1", device_name: "core1" }],
  b_points: [{ device: "x2", port: "e1", device_name: "core2" }],
})
const oneEnd = cable("one", {
  a_tiles: ["e"],
  a_points: [{ device: "x3", port: "e2", device_name: "edge1" }],
  b_far: [
    {
      device: "fw",
      port: "ethernet1/1",
      device_name: "aalborg-fw1",
      floor_plan: { id: "f1", name: "First floor" },
      place: { kind: "rack", id: "rack-9" },
    },
  ],
})
const hiddenFar = cable("hid", {
  b_tiles: ["e"],
  b_points: [{ device: "x3", port: "e3", device_name: "edge1" }],
  a_far: [{ device: null, port: null, hidden: true }],
})
const none = cable("none", { tray_ids: ["t9"] })
const paths = [both, oneEnd, hiddenFar, none]
const routes = new CableRouteCache().routes(paths, { trays: [], tiles })

describe("from afar", () => {
  it("a tile below the minimum on screen draws as a marker that size", () => {
    // 1187 mm cells at a fit zoom of ~3 px a cell.
    expect(tileMarkerCells(1, 1, 3)).toBeCloseTo(MIN_TILE_PX / 3)
    expect(tileMarkerCells(1, 1, 8)).toBeNull()
    expect(tileMarkerCells(4, 1, 3)).toBeNull()
  })

  it("TileMarkers draws only linked tiles, and leaves their geometry", () => {
    const zone = tile("z", 10, 10, { linked: null })
    const before = JSON.stringify(tiles)
    const { container } = render(
      <svg>
        <TileMarkers
          tiles={[...tiles, zone]}
          k={3 / 40}
          interactive
          isLocked={() => false}
          onPointerDown={() => {}}
        />
      </svg>
    )
    const marks = container.querySelectorAll("[data-tile-marker]")
    expect(marks).toHaveLength(3)
    // 8 px on screen at k: 8 / k plan px.
    expect(Number(marks[0].getAttribute("width"))).toBeCloseTo(8 / (3 / 40))
    expect(JSON.stringify(tiles)).toBe(before)
    // Close up, none.
    const near = render(
      <svg>
        <TileMarkers
          tiles={tiles}
          k={1}
          interactive
          isLocked={() => false}
          onPointerDown={() => {}}
        />
      </svg>
    )
    expect(near.container.querySelector("[data-tile-marker]")).toBeNull()
  })

  it("a run too short to see is a marker, gone when it reads", () => {
    expect(shortRuns(routes, 3).map((g) => g.ids)).toEqual([["both"]])
    expect(shortRuns(routes, 40)).toEqual([])
  })
})

describe("stubs", () => {
  const stubs = cableStubs(paths, routes, tiles, centre)

  it("a cable with one end here is a stub pointing out of its tile", () => {
    expect(stubs.map((s) => [s.id, s.end, s.tile])).toEqual([
      ["one", "A", "e"],
      ["hid", "B", "e"],
    ])
    // East of the centre: they point east, fanned round it.
    for (const s of stubs) expect(s.dir[0]).toBeGreaterThan(0.8)
    expect(stubs[0].dir[1]).not.toBeCloseTo(stubs[1].dir[1])
    // From the tile's edge, not its middle.
    expect(stubs[0].from[0]).toBeCloseTo(501)
    expect(stubs[0].far[0]).toMatchObject({ device_name: "aalborg-fw1" })
  })

  it("an end on a tile not shown is not on this plan", () => {
    const shown = tiles.filter((t) => t.id !== "e")
    expect(cableStubs(paths, routes, shown, centre)).toEqual([])
  })

  it("names the far end and its floor, Hidden masked", () => {
    expect(farEndLines(stubs[0].far)).toEqual([
      "Far end not on this plan: aalborg-fw1 · ethernet1/1",
      "On First floor",
    ])
    expect(farEndLines(stubs[1].far)).toEqual([
      "Far end not on this plan: Hidden",
    ])
    expect(stubPlaceIds(stubs)).toEqual(["rack-9"])
  })

  it("counts drawn, one end here and not placed", () => {
    expect(cableCounts(paths, routes, stubs)).toEqual({
      drawn: 1,
      oneEnd: 2,
      notPlaced: 1,
    })
  })

  it("the layer draws the stubs and the short run's marker from afar", () => {
    const { container } = render(
      <svg>
        <CableLayer
          cablePaths={paths}
          routes={routes}
          k={3 / 40}
          cellMm={plan.cell_mm}
          colorBy="status"
          bundle
          showLabels
          highlightIds={[]}
          interactive
          onSelect={() => {}}
          onHover={() => {}}
          stubs={stubs}
        />
      </svg>
    )
    expect(
      [...container.querySelectorAll("[data-stub]")].map((g) =>
        g.getAttribute("data-stub")
      )
    ).toEqual(["one", "hid"])
    expect(container.querySelector("[data-short='both']")).not.toBeNull()
    // A run on no tray still draws at far detail.
    expect(container.querySelector("[data-cable='both']")).not.toBeNull()
    expect(container.textContent).not.toContain("x3")
  })

  it("the popover names the far end; a Hidden one names nothing", () => {
    const { unmount } = render(
      <CablePopover
        target={{ ids: ["one"], x: 0, y: 0, pinned: false }}
        cablePaths={paths}
        routes={routes}
        stubs={stubs}
        trays={[]}
        cellMm={plan.cell_mm}
        onOpenChange={() => {}}
      />
    )
    expect(
      screen.getByText("Far end not on this plan: aalborg-fw1 · ethernet1/1")
    ).toBeTruthy()
    expect(screen.getByText("On First floor")).toBeTruthy()
    unmount()
    render(
      <CablePopover
        target={{ ids: ["hid"], x: 0, y: 0, pinned: false }}
        cablePaths={paths}
        routes={routes}
        stubs={stubs}
        trays={[]}
        cellMm={plan.cell_mm}
        onOpenChange={() => {}}
      />
    )
    expect(screen.getByText("Far end not on this plan: Hidden")).toBeTruthy()
    expect(document.body.textContent).not.toContain("On ")
  })

  it("the legend counts them; the middle figure opens Place", () => {
    const onPlaceFar = vi.fn()
    render(
      <TooltipProvider>
        <CableLegend
          legend={cableLegend(paths, "status", new Map())}
          counts={cableCounts(paths, routes, stubs)}
          onPlaceFar={onPlaceFar}
        />
      </TooltipProvider>
    )
    expect(screen.getByText("1 drawn")).toBeTruthy()
    expect(screen.getByText("1 not placed")).toBeTruthy()
    fireEvent.click(screen.getByText("2 with one end here"))
    expect(onPlaceFar).toHaveBeenCalledOnce()
  })

  it("the export draws the stubs, with the far end's name", () => {
    const svg = planSvg({
      plan,
      tiles,
      cables: {
        paths,
        routes,
        colorBy: "status",
        bundle: true,
        labels: true,
        mmPerPx: 0.01,
        stubs,
      },
    })
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
    const drawn = [...doc.querySelectorAll("[data-stub]")].map((p) =>
      p.getAttribute("data-stub")
    )
    expect(drawn).toEqual(["one", "hid"])
    const texts = [...doc.querySelectorAll("text")].map((t) => t.textContent)
    expect(texts).toContain("aalborg-fw1 · ethernet1/1")
    expect(texts).toContain("Hidden")
    expect(svg).not.toContain("x3")
    // Without stubs (a close-up), none.
    const bare = planSvg({
      plan,
      tiles,
      cables: {
        paths,
        routes,
        colorBy: "status",
        bundle: true,
        labels: true,
        mmPerPx: 0.01,
      },
    })
    expect(bare).not.toContain("data-stub")
  })
})
