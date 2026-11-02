// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import { planSvg } from "./plan-svg"
import {
  ICON_TILE_EXIT_PX,
  ICON_TILE_PX,
  READABLE_SYMBOL_PX,
  iconTileIds,
  iconTileShape,
  isIconTile,
  readIconTiles,
} from "./readable"

// Display > Icons when zoomed out: a device, rack or cabinet too small on
// screen draws as its icon tile - Readable's symbol, a square - with
// hysteresis about the threshold; the paper export does the same in mm.

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

const tile = (
  id: string,
  x: number,
  over: Partial<FloorPlanTile> = {}
): FloorPlanTile =>
  ({
    id,
    x,
    y: 100,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "#2563eb",
    status: "",
    linked: {
      kind: "device",
      id: `d-${id}`,
      name: `sw-${id}`,
      route: "/devices/x",
      icon: "router",
    },
    fov_anchor: "",
    fov_ptz: false,
    ...over,
  }) as unknown as FloorPlanTile

describe("the threshold", () => {
  const t = tile("a", 0)
  it("is on unless the plan turned it off", () => {
    expect(readIconTiles(undefined)).toBe(true)
    expect(readIconTiles(true)).toBe(true)
    expect(readIconTiles(false)).toBe(false)
  })

  it("turns a tile into its icon under ICON_TILE_PX", () => {
    expect(isIconTile(t, ICON_TILE_PX - 1, false)).toBe(true)
    expect(isIconTile(t, ICON_TILE_PX, false)).toBe(false)
  })

  it("holds an icon until it is over ICON_TILE_EXIT_PX", () => {
    const mid = (ICON_TILE_PX + ICON_TILE_EXIT_PX) / 2
    expect(isIconTile(t, mid, true)).toBe(true)
    expect(isIconTile(t, mid, false)).toBe(false)
    expect(isIconTile(t, ICON_TILE_EXIT_PX, true)).toBe(false)
  })

  it("leaves zones and planning tiles alone", () => {
    expect(isIconTile(tile("z", 0, { linked: null }), 4, false)).toBe(false)
    const zone = tile("z", 0, {
      tile_type: { is_zone: true } as FloorPlanTile["tile_type"],
    })
    expect(isIconTile(zone, 4, false)).toBe(false)
  })

  it("keeps the set while nothing crosses, so memos hold", () => {
    const tiles = [tile("a", 0), tile("b", 0, { width: 2 })]
    const prev = iconTileIds(tiles, 30, new Set())
    // 1 cell at 30 px and 2 cells at 60 px: only a.
    expect([...prev]).toEqual(["a"])
    // Zooming to 42 px a cell: a is held (under the exit), b stays a tile.
    expect(iconTileIds(tiles, 42, prev)).toBe(prev)
    // Fresh at 42 px nothing turns.
    expect(iconTileIds(tiles, 42, new Set()).size).toBe(0)
  })

  it("draws a square of Readable's least size about the centre", () => {
    const s = iconTileShape(tile("a", 10, { width: 2 }), 10)
    expect(s.box.w).toBeCloseTo(READABLE_SYMBOL_PX / 10)
    expect(s.box.h).toBe(s.box.w)
    expect(s.box.x + s.box.w / 2).toBe(11)
    expect(s.symbol).toBe(true)
  })
})

function draw(over: { iconTiles?: boolean; selectedId?: string } = {}) {
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={[
        tile("a", 100),
        tile("b", 300, {
          linked: {
            kind: "rack",
            id: "r",
            name: "R1",
            route: "/racks/r",
          },
        }),
      ]}
      selectedId={over.selectedId ?? null}
      editable={false}
      showGrid={false}
      armed={null}
      iconTiles={over.iconTiles}
      liveState={
        {
          tiles: { a: { kind: "device", check: "down" } },
        } as never
      }
      onClickTile={() => {}}
    />
  )
  const svg = r.container.querySelector("svg")!
  act(() => {
    fireEvent.wheel(svg, { deltaY: 3000 })
  })
  return r
}

describe("icon tiles on the canvas", () => {
  it("draws a far device and rack as icon tiles with their icons", () => {
    const { container } = draw()
    const a = container.querySelector('[data-tile="a"][data-icon-tile]')!
    expect(a).toBeTruthy()
    expect(a.querySelector('[data-part="symbol-icon"]')).toBeTruthy()
    // Monitoring still rings it.
    expect(a.querySelector('[data-part="alarm"]')).toBeTruthy()
    // A rack with no icon of its own wears its kind's default.
    const b = container.querySelector('[data-tile="b"][data-icon-tile]')!
    expect(b.querySelector('[data-part="symbol-icon"]')).toBeTruthy()
  })

  it("keeps the selection outline on an icon tile", () => {
    const { container } = draw({ selectedId: "a" })
    const rect = container.querySelector(
      '[data-tile="a"][data-icon-tile] rect:not([data-part])'
    )!
    expect(rect.getAttribute("stroke")).not.toBe("var(--background)")
  })

  it("draws today's tiles with the option off", () => {
    const { container } = draw({ iconTiles: false })
    expect(container.querySelector("[data-icon-tile]")).toBeNull()
  })
})

describe("icon tiles on paper", () => {
  const tiles = [tile("a", 10), tile("b", 20, { width: 30, height: 30 })]
  it("prints a small device as its icon tile, a big one as itself", () => {
    const svg = planSvg({ plan, tiles, iconTiles: true })
    expect(svg).toContain('data-icon-tile="a"')
    expect(svg).not.toContain('data-icon-tile="b"')
    // The icon itself, in white.
    expect(svg).toMatch(
      /data-icon-tile="a"[^>]*\/?>(<\/rect>)?<svg[^>]*stroke="#ffffff"/
    )
  })

  it("prints today's plan with the option off", () => {
    const svg = planSvg({ plan, tiles, iconTiles: false })
    expect(svg).not.toContain("data-icon-tile")
  })
})
