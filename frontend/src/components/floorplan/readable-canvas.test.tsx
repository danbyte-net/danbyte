// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import type { UseMutationResult } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile, FloorPlanTray } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { DisplayMenu } from "./display-menu"
import { FloorCanvas } from "./floor-canvas"
import { planSvg } from "./plan-svg"
import {
  READABLE_FONT_MM,
  READABLE_SYMBOL_MM,
  READABLE_TRAY_MM,
  READABLE_TRAY_PX,
} from "./readable"
import { TrayShape } from "./tray-layer"
import type { ObjectSize } from "./readable"
import { usePlanViewPrefs } from "./use-plan-view-prefs"

// Display > Object size, Readable: zoomed out, a placed object draws at a
// least size on screen centred on its place, still takes the pointer, and
// its name reads at a constant size; the paper export does the same in mm.
// The pref saves with the plan for an editor, and stays local for a viewer.

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

const tile = (id: string, x: number, y: number, name: string): FloorPlanTile =>
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
    linked: { kind: "rack", id: `r-${id}`, name, route: "/racks/x" },
    fov_anchor: "",
    fov_ptz: false,
  }) as unknown as FloorPlanTile

const tiles = [tile("a", 100, 100, "Rack A1"), tile("b", 300, 100, "Rack B1")]

function draw(objectSize: ObjectSize, onClickTile = vi.fn()) {
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={tiles}
      selectedId={null}
      editable={false}
      showGrid={false}
      armed={null}
      objectSize={objectSize}
      onClickTile={onClickTile}
    />
  )
  // Zoom right out: the wheel's floor, 0.15 - 6 px a cell.
  const svg = r.container.querySelector("svg")!
  act(() => {
    fireEvent.wheel(svg, { deltaY: 3000 })
  })
  return { ...r, onClickTile }
}

const group = (c: HTMLElement, id: string) =>
  c.querySelector<SVGGElement>(`g[data-tile="${id}"]`)!.parentElement!

describe("Readable on the canvas", () => {
  it("grows a small tile about its centre and names it", async () => {
    const { container } = draw("readable")
    const g = group(container, "a")
    expect(g.hasAttribute("data-grown")).toBe(true)
    // 28 px over 6 px a cell, about the tile's centre (100.5 cells).
    const m = /translate\(([\d.]+),([\d.]+)\) scale\(([\d.]+)\)/.exec(
      g.getAttribute("transform") ?? ""
    )!
    expect(+m[1]).toBe(100.5 * 40)
    expect(+m[3]).toBeCloseTo(28 / 6)
    // Its own name gives way to the label pass's, 11 px on screen, once
    // the zoom settles.
    await waitFor(() =>
      expect(container.querySelectorAll("[data-readable-name]")).toHaveLength(2)
    )
    const names = container.querySelectorAll("[data-readable-name]")
    expect([...names].map((n) => n.textContent)).toEqual(["Rack A1", "Rack B1"])
    expect(+names[0].getAttribute("font-size")! * 0.15).toBeCloseTo(11)
    // The 8 px markers are Real's.
    expect(container.querySelector("[data-tile-marker]")).toBeNull()
  })

  it("the grown symbol takes the pointer", () => {
    const { container, onClickTile } = draw("readable")
    fireEvent.pointerDown(container.querySelector('g[data-tile="b"]')!, {
      button: 0,
    })
    expect(onClickTile).toHaveBeenCalledWith(tiles[1])
  })

  it("Real draws the tile at its size, with its marker", () => {
    const { container } = draw("real")
    expect(group(container, "a").hasAttribute("data-grown")).toBe(false)
    expect(container.querySelector("[data-readable-name]")).toBeNull()
    expect(container.querySelector("[data-tile-marker]")).toBeTruthy()
  })
})

describe("Readable on paper", () => {
  const mmPerPx = 0.02
  const doc = (objectSize: ObjectSize) =>
    new DOMParser().parseFromString(
      planSvg({ plan, tiles, objectSize, mmPerPx }),
      "image/svg+xml"
    )

  it("draws objects at least READABLE_SYMBOL_MM, names at READABLE_FONT_MM", () => {
    const d = doc("readable")
    const grown = [...d.querySelectorAll("g[transform]")].find((g) =>
      g.getAttribute("transform")!.includes("scale(")
    )!
    const scale = +/scale\(([\d.]+)\)/.exec(
      grown.getAttribute("transform")!
    )![1]
    // 40 px a cell at 0.02 mm a px: 0.8 mm, grown to 5 mm.
    expect(scale * 40 * mmPerPx).toBeCloseTo(READABLE_SYMBOL_MM, 2)
    const names = d.querySelectorAll('[data-layer="readable-names"] text')
    expect([...names].map((n) => n.textContent)).toContain("Rack A1")
    expect(+names[0].getAttribute("font-size")! * mmPerPx).toBeCloseTo(
      READABLE_FONT_MM,
      2
    )
  })

  it("Real stays as it was", () => {
    const d = doc("real")
    expect(d.querySelector('[data-layer="readable-names"]')).toBeNull()
    expect(
      [...d.querySelectorAll("g[transform]")].some((g) =>
        g.getAttribute("transform")!.includes("scale(")
      )
    ).toBe(false)
  })
})

function Harness({
  canEdit,
  mutate,
}: {
  canEdit: boolean
  mutate: (v: unknown) => void
}) {
  const prefs = usePlanViewPrefs({
    id: "p1",
    plan,
    canEdit,
    patchPlan: { mutate } as unknown as UseMutationResult<
      FloorPlan,
      Error,
      Record<string, unknown>
    >,
  })
  return (
    <TooltipProvider>
      <span data-testid="size">{prefs.objectSize}</span>
      <DisplayMenu view3d={false} prefs={prefs} />
    </TooltipProvider>
  )
}

describe("Display > Object size", () => {
  it("is Readable by default and saves Real on the plan for an editor", async () => {
    const mutate = vi.fn()
    render(<Harness canEdit mutate={mutate} />)
    expect(screen.getByTestId("size").textContent).toBe("readable")
    fireEvent.click(screen.getByRole("button", { name: /Display/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Real" }))
    expect(screen.getByTestId("size").textContent).toBe("real")
    expect(mutate).toHaveBeenCalledWith({
      state: { object_size: "real" },
    })
  })

  it("is the viewer's own without change rights", async () => {
    const mutate = vi.fn()
    render(<Harness canEdit={false} mutate={mutate} />)
    fireEvent.click(screen.getByRole("button", { name: /Display/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Real" }))
    expect(screen.getByTestId("size").textContent).toBe("real")
    expect(mutate).not.toHaveBeenCalled()
  })

  it("keeps a plan that chose Real", () => {
    expect(usePlanViewPrefsStateDefault({ object_size: "real" })).toBe("real")
  })
})

/** The prefs' Object size for a plan's saved state. */
function usePlanViewPrefsStateDefault(state: Record<string, unknown>) {
  let got = ""
  function Probe() {
    got = usePlanViewPrefs({
      id: "p2",
      plan: { ...plan, state },
      canEdit: false,
      patchPlan: { mutate: vi.fn() } as unknown as UseMutationResult<
        FloorPlan,
        Error,
        Record<string, unknown>
      >,
    }).objectSize
    return null
  }
  render(<Probe />)
  return got
}

describe("Readable trays", () => {
  const tray = {
    id: "tr1",
    name: "Duct A",
    color: "",
    points: [
      [0, 0],
      [100, 0],
    ],
    cables: ["c1", "c2"],
    hidden_cable_count: 0,
  } as unknown as FloorPlanTray
  const shape = (readable: boolean, zoom = 0.05) =>
    render(
      <svg>
        <TrayShape
          tray={tray}
          selected={false}
          interactive={false}
          editable={false}
          editing={false}
          dimmed={false}
          onPointerDown={() => {}}
          onDoubleClick={() => {}}
          onVertexDown={() => {}}
          onInsertBend={() => {}}
          onVertexContext={() => {}}
          zoom={zoom}
          readable={readable}
        />
      </svg>
    ).container

  it("keeps a least width and a readable count from afar", () => {
    const c = shape(true)
    const w = +c
      .querySelector("polyline[data-part=channel]")!
      .getAttribute("stroke-width")!
    expect(w * 0.05).toBeCloseTo(READABLE_TRAY_PX)
    // On a casing a little wider, in the background's colour.
    const casing = c.querySelector("polyline[data-part=casing]")!
    expect(casing.getAttribute("stroke")).toBe("var(--background)")
    expect(+casing.getAttribute("stroke-width")!).toBeGreaterThan(w)
    const t = c.querySelector("text")!
    expect(t.textContent).toBe("Duct A · 2")
    expect(+t.getAttribute("font-size")! * 0.05).toBeCloseTo(11)
  })

  it("Real keeps the 10 px channel up close, never a hairline from afar", () => {
    const near = shape(false, 1)
    expect(
      near
        .querySelector("polyline[data-part=channel]")!
        .getAttribute("stroke-width")
    ).toBe("10")
    cleanup()
    const far = shape(false)
    const w = +far
      .querySelector("polyline[data-part=channel]")!
      .getAttribute("stroke-width")!
    expect(w * 0.05).toBeCloseTo(4)
  })

  it("on paper: at least READABLE_TRAY_MM, its count at READABLE_FONT_MM", () => {
    const mmPerPx = 0.02
    const svg = planSvg({
      plan,
      tiles: [],
      trays: [tray],
      objectSize: "readable",
      mmPerPx,
    })
    const d = new DOMParser().parseFromString(svg, "image/svg+xml")
    const line = d.querySelector("polyline:not([data-part=casing])")!
    expect(+line.getAttribute("stroke-width")! * mmPerPx).toBeCloseTo(
      READABLE_TRAY_MM,
      2
    )
    const label = [...d.querySelectorAll("text")].pop()!
    expect(label.textContent).toBe("Duct A · 2")
    expect(+label.getAttribute("font-size")! * mmPerPx).toBeCloseTo(
      READABLE_FONT_MM,
      2
    )
  })
})
