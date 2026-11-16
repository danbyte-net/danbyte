// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile, FloorPlanWall } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import type { FloorCanvasProps } from "./floor-canvas"
import { planSvg } from "./plan-svg"
import type { AreaShape } from "./shapes"

// Detail by zoom on the canvas. jsdom lays nothing out, so the plan sits
// at zoom 1 - 40 px to a cell - and a cell's size picks the level: 600 mm
// is 67 px a metre (detail), 2 m is 20 (room), 10 m is 4 (overview).

vi.mock("@/lib/use-me", () => ({ useMe: () => ({}) }))
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
})
afterEach(cleanup)

const planOf = (cellMm: number, patch: Partial<FloorPlan> = {}) =>
  ({
    id: "p1",
    name: "Hall",
    grid_width: 40,
    grid_height: 30,
    cell_mm: cellMm,
    ceiling_mm: 3000,
    background_image: null,
    background_opacity: 60,
    state: {},
    layout_mode: "grid",
    ...patch,
  }) as unknown as FloorPlan

const hall: AreaShape = {
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 0,
  y: 0,
  width: 40,
  height: 30,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "Data Hall 5",
  color: "",
  fill_opacity: 12,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
} as unknown as AreaShape

const rack = (n: number): FloorPlanTile =>
  ({
    id: `t${n}`,
    x: 4 + n,
    y: 4,
    width: 1,
    height: 2,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "#6366f1",
    status: "",
    linked: {
      kind: "rack",
      id: `r${n}`,
      name: `DH5-A0${n}`,
      route: "/racks/x",
    },
    fov_anchor: "",
    fov_ptz: false,
  }) as unknown as FloorPlanTile

const camera = {
  ...rack(0),
  id: "cam",
  x: 20,
  y: 20,
  width: 1,
  height: 1,
  linked: null,
  label: "CCTV",
  tile_type: {
    id: "camt",
    name: "Camera",
    slug: "camera",
    color: "#64748b",
    icon: "cctv",
    default_width: 1,
    default_height: 1,
    is_zone: false,
    has_fov: true,
  },
  fov_deg: 90,
  fov_distance: 3000,
  fov_direction: 0,
} as unknown as FloorPlanTile

const tiles = [1, 2, 3, 4].map(rack)

/** The markup less React's per-render ids. */
const html = (c: Element) => c.innerHTML.replace(/_r_[0-9a-z]+_/g, "ID")

function draw(cellMm: number, props: Partial<FloorCanvasProps> = {}) {
  const r = render(
    <FloorCanvas
      plan={planOf(cellMm)}
      tiles={tiles}
      shapes={[hall]}
      selectedId={null}
      editable={false}
      showGrid={false}
      armed={null}
      {...props}
    />
  )
  return r.container
}

describe("Always full", () => {
  it("draws what the canvas drew before, at every level", () => {
    for (const cell of [600, 2000, 10000]) {
      const before = html(draw(cell))
      cleanup()
      const full = html(draw(cell, { detail: "full" }))
      cleanup()
      expect(full).toBe(before)
    }
  })

  it("is what Auto draws while editing", () => {
    const full = html(draw(10000, { detail: "full", editable: true }))
    cleanup()
    const auto = html(draw(10000, { detail: "auto", editable: true }))
    expect(auto).toBe(full)
  })
})

describe("the overview", () => {
  it("draws the rooms with their labels and no tiles", () => {
    const c = draw(10000, { detail: "auto" })
    expect(c.querySelectorAll("[data-tile]")).toHaveLength(0)
    const label = c.querySelector('[data-room-label="a1"]')
    expect(label?.textContent).toContain("Data Hall 5")
    expect(label?.textContent).toContain("4 racks")
    // The room's own name gives way to the label.
    expect(c.querySelector('[data-area="a1"] [data-part=area-name]')).toBeNull()
  })

  it("still draws the selection", () => {
    const c = draw(10000, { detail: "auto", selectedId: "t2" })
    expect(
      [...c.querySelectorAll("[data-tile]")].map((e) =>
        e.getAttribute("data-tile")
      )
    ).toEqual(["t2"])
  })

  it("puts a room's alarm on its label", () => {
    const c = draw(10000, {
      detail: "auto",
      liveState: {
        as_of: "",
        tiles: {
          t1: {
            kind: "rack",
            used_units: 0,
            u_height: 42,
            power: {} as never,
            total_weight_kg: 0,
            max_weight_kg: null,
            device_count: 0,
            check: "down",
          },
        },
      },
    })
    expect(
      c.querySelector('[data-room-label="a1"] [data-part=room-alarm]')
        ?.textContent
    ).toBe("1 down")
  })

  it("blanks the base map inside the building", () => {
    const wall = {
      id: "w1",
      label: "",
      points: [
        [1, 1],
        [30, 1],
        [30, 20],
        [1, 20],
        [1, 1],
      ],
      height_mm: null,
      color: "",
      openings: [],
      exterior: true,
    } as unknown as FloorPlanWall
    const plan = planOf(10000, {
      map_visible: true,
      base_map: { image: "/media/map.png", basemap: "map" },
    } as Partial<FloorPlan>)
    const r = render(
      <FloorCanvas
        plan={plan}
        tiles={tiles}
        shapes={[hall]}
        walls={[wall]}
        selectedId={null}
        editable={false}
        showGrid={false}
        armed={null}
        detail="auto"
      />
    )
    const mask = r.container.querySelector("[data-layer=map-mask]")
    expect(mask).not.toBeNull()
    // Over the map, under everything else.
    const map = r.container.querySelector("[data-layer=map]")!
    expect(
      map.compareDocumentPosition(mask!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(mask!.querySelectorAll("path")).toHaveLength(2)
    cleanup()
    const full = render(
      <FloorCanvas
        plan={plan}
        tiles={tiles}
        shapes={[hall]}
        walls={[wall]}
        selectedId={null}
        editable={false}
        showGrid={false}
        armed={null}
        detail="full"
      />
    )
    expect(full.container.querySelector("[data-layer=map-mask]")).toBeNull()
  })
})

describe("the room level", () => {
  it("draws the racks without their names", () => {
    const c = draw(2000, { detail: "auto" })
    expect(c.querySelectorAll("[data-tile]").length).toBe(4)
    expect(c.querySelector("[data-room-label]")).toBeNull()
    const texts = [...c.querySelectorAll("[data-tile] text")].map(
      (e) => e.textContent
    )
    expect(texts.filter((t) => t.includes("A0"))).toEqual([])
  })
})

describe("the detail level", () => {
  it("names a rack by what its row does not say", () => {
    const c = draw(600, { detail: "auto" })
    const t1 = c.querySelector('[data-tile="t1"]')!
    expect(t1.querySelector("text")?.textContent).toBe("A01")
    // Its full name stays its accessible name.
    expect(t1.getAttribute("aria-label")).toContain("DH5-A01")
  })

  it("names the selection in full", () => {
    const c = draw(600, { detail: "auto", selectedId: "t1" })
    // Its full name, cut to its tile as always.
    expect(c.querySelector('[data-tile="t1"] text')?.textContent).toMatch(
      /^DH5-/
    )
  })

  it("draws a camera's cone only in focus or with coverage on", () => {
    const withCam = [...tiles, camera]
    expect(
      draw(600, {
        detail: "auto",
        tiles: withCam,
        showFov: true,
      }).querySelectorAll("[data-fov]").length
    ).toBe(0)
    cleanup()
    expect(
      draw(600, {
        detail: "auto",
        tiles: withCam,
        showFov: true,
        selectedId: "cam",
      }).querySelectorAll("[data-fov]").length
    ).toBe(1)
    cleanup()
    expect(
      draw(600, {
        detail: "full",
        tiles: withCam,
        showFov: true,
      }).querySelectorAll("[data-fov]").length
    ).toBe(1)
  })

  it("prints full names on paper whatever the canvas shows", () => {
    // Wide enough for the whole name.
    const wide = tiles.map((t, i) => ({ ...t, x: 2 + i * 5, width: 4 }))
    const svg = planSvg({ plan: planOf(600), tiles: wide })
    expect(svg).toContain(">DH5-A01<")
    expect(svg).not.toContain(">A01<")
  })
})

describe("a room too small for its name", () => {
  it("names itself under the pointer", () => {
    const stair = {
      ...hall,
      id: "a2",
      label: "Stair N",
      x: 30,
      y: 25,
      // Under OVERHANG_MIN_PX on screen: named on hover only.
      width: 0.5,
      height: 0.5,
    } as AreaShape
    const c = draw(10000, { detail: "auto", shapes: [hall, stair] })
    expect(c.querySelector('[data-room-label="a2"]')).toBeNull()
    const svg = c.querySelector("svg")!
    // jsdom: the plan 40 px in, 40 px a cell.
    fireEvent.pointerMove(svg, {
      clientX: 40 + 30.25 * 40,
      clientY: 40 + 25.25 * 40,
    })
    expect(c.querySelector("[data-part=room-hint]")).not.toBeNull()
    expect(document.body.textContent).toContain("Stair N")
    // Over the hall, whose label says its name: no tooltip.
    fireEvent.pointerMove(svg, { clientX: 40 + 5 * 40, clientY: 40 + 5 * 40 })
    expect(c.querySelector("[data-part=room-hint]")).toBeNull()
  })
})
