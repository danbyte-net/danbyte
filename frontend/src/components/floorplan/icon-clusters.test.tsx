// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import { layoutPlanLabels } from "./plan-label-pass"
import { Occupancy, aroundSpots, placeLabels } from "./plan-labels"
import { planSvg } from "./plan-svg"

// Crowded icon tiles: spread where there is room, clustered where not, on
// the canvas and on paper; their names round their own icon, never over
// another.

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

const plan = {
  id: "p1",
  name: "Site",
  grid_width: 512,
  grid_height: 266,
  cell_mm: 1200,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
} as unknown as FloorPlan

const rack = (id: string, name: string, x: number, y = 100): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: name,
    color: "#2563eb",
    status: "",
    linked: { kind: "rack", id: `r-${id}`, name, route: "/racks/x" },
    fov_anchor: "",
    fov_ptz: false,
  }) as unknown as FloorPlanTile

/** A row of eight racks side by side: too many to spread. */
const row = Array.from({ length: 8 }, (_, i) =>
  rack(`r${i}`, `R-A0${i + 1}`, 100 + i)
)

function draw(
  tiles: FloorPlanTile[],
  over: { iconTiles?: boolean; selectedId?: string } = {}
) {
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={tiles}
      selectedId={over.selectedId ?? null}
      editable={false}
      showGrid={false}
      armed={null}
      iconTiles={over.iconTiles}
      liveState={
        {
          tiles: { r2: { kind: "rack", check: "degraded" } },
        } as never
      }
      onClickTile={() => {}}
    />
  )
  const svg = r.container.querySelector("svg")!
  act(() => {
    fireEvent.wheel(svg, { deltaY: 3000 })
  })
  // Let the view settle: the layout runs on the settled zoom.
  act(() => {
    vi.advanceTimersByTime(500)
  })
  return r
}

describe("crowded icons on the canvas", () => {
  it("folds a row too crowded to spread into a cluster", () => {
    vi.useFakeTimers()
    const { container } = draw(row)
    const clusters = container.querySelectorAll("[data-icon-cluster]")
    expect(clusters.length).toBeGreaterThan(0)
    // A clustered rack draws no icon of its own.
    const drawn = container.querySelectorAll("[data-icon-tile]").length
    expect(drawn).toBeLessThan(row.length)
    // The count, and the worst state's ring when a member alarms.
    const c = clusters[0]
    expect(c.querySelector('[data-part="cluster-count"]')?.textContent).toMatch(
      /^\d+$/
    )
    vi.useRealTimers()
  })

  it("pulls the selected rack out of its cluster", () => {
    vi.useFakeTimers()
    const { container } = draw(row, { selectedId: "r3" })
    expect(
      container.querySelector('[data-tile="r3"][data-icon-tile]')
    ).toBeTruthy()
    vi.useRealTimers()
  })

  it("does nothing of the sort with icons off", () => {
    vi.useFakeTimers()
    const { container } = draw(row, { iconTiles: false })
    expect(container.querySelector("[data-icon-cluster]")).toBeNull()
    expect(container.querySelector("[data-icon-leader]")).toBeNull()
    vi.useRealTimers()
  })
})

describe("crowded icons on paper", () => {
  it("clusters at the paper's scale and names the range", () => {
    const svg = planSvg({ plan, tiles: row, iconTiles: true })
    expect(svg).toContain("data-icon-cluster=")
    expect(svg).toMatch(/R-A0\d–R-A0\d/)
  })

  it("spreads two that overlap, with a leader each", () => {
    const two = [rack("a", "sw1", 100), rack("b", "sw2", 100.3)]
    const svg = planSvg({ plan, tiles: two, iconTiles: true })
    expect(svg).not.toContain("data-icon-cluster=")
    expect(svg.match(/data-icon-leader/g)?.length).toBe(2)
  })

  it("prints none of it with icons off", () => {
    const svg = planSvg({ plan, tiles: row, iconTiles: false })
    expect(svg).not.toContain("data-icon-cluster")
    expect(svg).not.toContain("data-icon-leader")
  })
})

describe("names round an icon", () => {
  const icon = { x: 10, y: 10, w: 1, h: 1 }
  const size = { w: 30, h: 12 }
  it("tries right, left, below, above, then the corners", () => {
    const spots = aroundSpots(icon, size, 2, 28)
    const c = spots.map((s) => [
      s.box.x + s.box.w / 2 - 10.5 * 28,
      s.box.y + s.box.h / 2 - 10.5 * 28,
    ])
    expect(c[0][0]).toBeGreaterThan(0)
    expect(c[0][1]).toBe(0)
    expect(c[1][0]).toBeLessThan(0)
    expect(c[2][1]).toBeGreaterThan(0)
    expect(c[3][1]).toBeLessThan(0)
    expect(spots).toHaveLength(8)
    // None overlaps the icon itself.
    for (const s of spots)
      expect(
        s.box.x < 11 * 28 &&
          s.box.x + s.box.w > 10 * 28 &&
          s.box.y < 11 * 28 &&
          s.box.y + s.box.h > 10 * 28
      ).toBe(false)
  })

  it("never goes over another icon, and hides when it has to", () => {
    const spots = aroundSpots(icon, size, 2, 28)
    // An icon right of it: the name goes left.
    const block = new Occupancy()
    block.add(spots[0].box)
    const placed = placeLabels([{ id: "a", priority: 1, spots, block }])
    expect(placed.get("a")).toBe(spots[1])
    // Icons all round: no name.
    const full = new Occupancy()
    for (const s of spots) full.add(s.box)
    expect(
      placeLabels([{ id: "a", priority: 1, spots, block: full }]).size
    ).toBe(0)
    // Unless it is forced (selected, hovered).
    expect(
      placeLabels([{ id: "a", priority: 1, spots, block: full, force: true }])
        .size
    ).toBe(1)
  })

  it("names a cluster, not its members", () => {
    const tiles = [rack("a", "R-A01", 10), rack("b", "R-A02", 11)]
    const box = (t: FloorPlanTile) => ({ x: t.x, y: t.y, w: 1, h: 1 })
    const out = layoutPlanLabels({
      scale: 28,
      unitsPerPx: 1,
      font: 11,
      chipFont: 10,
      repeat: 280,
      gap: 4,
      tiles,
      shapeOf: (t) => ({ box: box(t), grow: 1, changed: true, symbol: true }),
      iconIds: new Set(["a", "b"]),
      iconClusters: [
        {
          id: "cluster:a",
          box: { x: 10, y: 10, w: 1.2, h: 1.2 },
          name: "R-A01–R-A02",
          members: ["a", "b"],
        },
      ],
      cellMm: 600,
    })
    expect(out.tiles.map((l) => l.text)).toEqual(["R-A01–R-A02"])
    expect(out.tileNamesHere.has("a")).toBe(true)
  })

  it("lays out the same names twice the same way", () => {
    const tiles = [rack("a", "sw1", 10), rack("b", "sw2", 11.2)]
    const input = {
      scale: 28,
      unitsPerPx: 1,
      font: 11,
      chipFont: 10,
      repeat: 280,
      gap: 4,
      tiles,
      shapeOf: (t: FloorPlanTile) => ({
        box: { x: t.x, y: t.y, w: 1, h: 1 },
        grow: 1,
        changed: true,
        symbol: true,
      }),
      iconIds: new Set(["a", "b"]),
      cellMm: 600,
    }
    expect(layoutPlanLabels(input).tiles).toEqual(layoutPlanLabels(input).tiles)
  })
})
