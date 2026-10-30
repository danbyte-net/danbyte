// @vitest-environment jsdom
import { useState } from "react"
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  render,
  screen,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import * as draw from "./cable-draw"
import { CableLayer } from "./cable-layer"
import { CablePopover } from "./cable-popover"
import { useCableRoutes } from "./use-cable-routes"
import type { Pt } from "./cable-route"

// The cable layer on the canvas: what it draws at each level of detail,
// that its strokes keep their width on screen, that a pan (the canvas
// re-rendering with the same cables) does not draw it again - and the
// popover a run opens, with an end the reader may not view read Hidden.

vi.mock("./cable-draw", async (importOriginal) => {
  const mod = await importOriginal<typeof draw>()
  return { ...mod, endText: vi.fn(mod.endText) }
})
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

const tile = (id: string, x: number, y: number): FloorPlanTile =>
  ({ id, x, y, width: 1, height: 1 }) as FloorPlanTile
const tiles = [tile("r1", 1, 3), tile("r2", 9, 3)]
const tray = {
  id: "t1",
  name: "T1",
  points: [
    [0, 2],
    [12, 2],
  ] as Pt[],
  level: "overhead",
  elevation_mm: null,
  cables: [],
  hidden_cable_count: 0,
} as unknown as FloorPlanTray

const cable = (id: string, patch: Partial<FloorPlanCablePath> = {}) =>
  ({
    id,
    label: `C-${id}`,
    color: "",
    type: "cat6",
    type_display: "Cat6",
    a_tiles: ["r1"],
    b_tiles: ["r2"],
    a_points: [{ device: "d1", port: "eth1", device_name: "sw1" }],
    b_points: [{ device: "d2", port: "eth9", device_name: "sw2" }],
    tray_ids: ["t1"],
    ...patch,
  }) as FloorPlanCablePath

const cps = [cable("1"), cable("2"), cable("3")]
const routes = new draw.CableRouteCache().routes(cps, {
  trays: [tray],
  tiles,
  ceilingMm: 3000,
})

const layer = (k: number, patch: Record<string, unknown> = {}) => (
  <svg>
    <CableLayer
      cablePaths={cps}
      routes={routes}
      k={k}
      cellMm={600}
      colorBy="status"
      bundle
      showLabels
      highlightIds={[]}
      interactive
      onSelect={() => {}}
      onHover={() => {}}
      {...patch}
    />
  </svg>
)

describe("CableLayer level of detail", () => {
  it("far: no runs, only a traced one", () => {
    const { container, rerender } = render(layer(0.2))
    const g = container.querySelector("[data-layer=cables]")!
    expect(g.getAttribute("data-lod")).toBe("far")
    expect(container.querySelectorAll("[data-cable]")).toHaveLength(0)
    expect(container.querySelectorAll("[data-bundle]")).toHaveLength(0)
    rerender(layer(0.2, { highlightIds: ["2"] }))
    expect(container.querySelector("[data-lifted='2']")).not.toBeNull()
  })

  it("mid: the shared tray is one bundle with its count, no labels", () => {
    const { container } = render(layer(0.6))
    expect(
      container.querySelector("[data-layer=cables]")!.getAttribute("data-lod")
    ).toBe("mid")
    const bundle = container.querySelector("[data-bundle]")!
    expect(bundle.getAttribute("aria-label")).toBe("3 cables")
    expect(bundle.textContent).toBe("3")
    expect(screen.queryByText("C-1")).toBeNull()
  })

  it("near: every lane, with labels, and a click fans a bundle out", () => {
    const { container } = render(layer(2))
    expect(container.querySelectorAll("[data-bundle]")).toHaveLength(0)
    expect(container.querySelectorAll("[data-cable]")).toHaveLength(3)
    expect(screen.getByText("C-1")).toBeTruthy()

    const off = render(layer(0.6, { showLabels: false }))
    const bundle = off.container.querySelector("[data-bundle]")!
    fireEvent.pointerDown(bundle)
    expect(off.container.querySelector("[data-bundle]")).toBeNull()
    expect(off.container.querySelectorAll("[data-cable]")).toHaveLength(3)
  })

  it("keeps every stroke its width on screen at any zoom", () => {
    const { container } = render(layer(2))
    const strokes = [...container.querySelectorAll("path")].filter(
      (p) => p.getAttribute("stroke") !== "transparent"
    )
    expect(strokes.length).toBeGreaterThan(0)
    for (const p of strokes)
      expect(p.getAttribute("vector-effect")).toBe("non-scaling-stroke")
  })

  it("is a focusable button per run, its ends in its name", () => {
    const onSelect = vi.fn()
    const { container } = render(layer(2, { onSelect }))
    const run = container.querySelector("[data-cable='1']")!
    expect(run.getAttribute("tabindex")).toBe("0")
    expect(run.getAttribute("aria-label")).toBe(
      "Cable C-1: sw1 · eth1 to sw2 · eth9"
    )
    fireEvent.keyDown(run, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("1")
  })
})

describe("CableLayer renders", () => {
  it("does not draw again when the canvas re-renders for a pan", () => {
    const spy = vi.mocked(draw.endText)
    let pan: (n: number) => void = () => {}
    function Canvas() {
      const [x, setX] = useState(0)
      pan = setX
      return (
        <svg data-x={x}>
          <CableLayer
            cablePaths={cps}
            routes={routes}
            k={2}
            cellMm={600}
            colorBy="status"
            bundle
            showLabels={false}
            highlightIds={NO_IDS}
            interactive
            onSelect={noop}
            onHover={noop}
          />
        </svg>
      )
    }
    render(<Canvas />)
    const drawn = spy.mock.calls.length
    expect(drawn).toBeGreaterThan(0)
    act(() => pan(10))
    act(() => pan(20))
    expect(spy.mock.calls.length).toBe(drawn)
  })
})

const NO_IDS: string[] = []
const noop = () => {}

describe("CableLayer stored, stale and preview routes", () => {
  const leg = {
    from: { end: "A" as const, tile: "r1", device: "d1", at: [1.5, 3.5] },
    to: { end: "B" as const, tile: "r2", device: "d2", at: [9.5, 3.5] },
    points: [
      [1.5, 3.5],
      [1.5, 2],
      [9.5, 2],
      [9.5, 3.5],
    ],
    trays: [{ id: "t1", entry: [1.5, 2], exit: [9.5, 2], elevation_mm: 2700 }],
    waypoints: [],
  }
  const path = {
    kind: "trays" as const,
    legs: [leg],
    tray_order: ["t1"],
    run_mm: 6600,
    drop_a_mm: 800,
    drop_b_mm: 800,
    extra_mm: 0,
    slack_mm: 820,
    length_mm: 9000,
  } as unknown as NonNullable<FloorPlanCablePath["path"]>
  const strokeOf = (container: HTMLElement, id: string) =>
    container
      .querySelector(`[data-cable='${id}'] path:not([stroke=transparent])`)!
      .getAttribute("stroke-width")

  it("draws a documented route solid and full width, an inferred one thin", () => {
    const stored = [
      cable("1", { path: { ...path, version: "v1" } }),
      cable("2"),
    ]
    const r = new draw.CableRouteCache().routes(stored, {
      trays: [tray],
      tiles,
      ceilingMm: 3000,
    })
    const { container } = render(
      layer(2, { cablePaths: stored, routes: r, bundle: false })
    )
    expect(strokeOf(container, "1")).toBe(
      String(draw.CABLE_LINE.documented.width)
    )
    expect(strokeOf(container, "2")).toBe(
      String(draw.CABLE_LINE.inferred.width)
    )
  })

  it("marks an out-of-date route's moved end", () => {
    const moved = [tile("r1", 1, 3), tile("r2", 9, 6)]
    const stale = [cable("1", { path: { ...path, version: "v1" } })]
    const r = new draw.CableRouteCache().routes(stale, {
      trays: [tray],
      tiles: moved,
      ceilingMm: 3000,
    })
    const { container } = render(layer(2, { cablePaths: stale, routes: r }))
    const mark = container.querySelector("[data-stale='1']")
    expect(mark).not.toBeNull()
    expect(mark!.querySelector("path")!.getAttribute("stroke-dasharray")).toBe(
      "4 3"
    )
  })

  it("draws a preview dotted with its length", () => {
    const tileById = new Map(tiles.map((t) => [t.id, t]))
    const preview = draw.pathRoute(
      "1",
      path,
      tileById,
      new Map([[tray.id, tray]])
    )!
    const { container } = render(
      layer(2, { previews: new Map([["1", preview]]) })
    )
    const g = container.querySelector("[data-preview='1']")!
    const dotted = [...g.querySelectorAll("path")].find(
      (p) => p.getAttribute("stroke-dasharray") === draw.CABLE_LINE.preview.dash
    )
    expect(dotted).toBeTruthy()
    expect(g.textContent).toBe("9.0 m")
  })
})

describe("useCableRoutes", () => {
  it("keeps the routes while the plan's contents stay the same", () => {
    const trays = [tray]
    const { result, rerender } = renderHook(
      ({ t }) => useCableRoutes(cps, trays, t, 3000, undefined),
      { initialProps: { t: tiles } }
    )
    const first = result.current
    expect(first.size).toBe(3)
    rerender({ t: tiles })
    expect(result.current).toBe(first)
    // A tile moved: new routes, the untouched ones the same objects.
    rerender({ t: [tiles[0], tile("r2", 9, 5)] })
    expect(result.current).not.toBe(first)
    expect(result.current.get("1")).not.toBe(first.get("1"))
  })
})

describe("CablePopover", () => {
  it("shows both ends, Hidden for one the reader may not view", () => {
    const hiddenEnd = cable("1", {
      label: "C-77",
      b_points: [{ device: null, port: null, hidden: true }],
      status: {
        id: "s",
        name: "Active",
        color: "22c55e",
        text_color: "#000",
        is_planned: false,
      },
      length: 9,
      length_unit: "m",
    })
    render(
      <CablePopover
        target={{ ids: ["1"], x: 10, y: 10, pinned: true }}
        cablePaths={[hiddenEnd]}
        routes={routes}
        trays={[tray]}
        cellMm={600}
        onOpenChange={() => {}}
      />
    )
    expect(screen.getByText("C-77")).toBeTruthy()
    expect(screen.getByText("sw1 · eth1")).toBeTruthy()
    expect(screen.getByText("Hidden")).toBeTruthy()
    expect(screen.getByText("Active")).toBeTruthy()
    expect(screen.getByText("Cat6")).toBeTruthy()
    expect(screen.getByText("9 m")).toBeTruthy()
    expect(screen.getByText("T1")).toBeTruthy()
    expect(screen.getByText("Open cable")).toBeTruthy()
    // Hidden ends name nothing.
    expect(document.body.textContent).not.toContain("d2")
  })

  it("lists a bundle's cables", () => {
    render(
      <CablePopover
        target={{
          ids: ["1", "2"],
          bundle: "t:t1:0",
          x: 0,
          y: 0,
          pinned: false,
        }}
        cablePaths={cps}
        routes={routes}
        trays={[tray]}
        cellMm={600}
        onOpenChange={() => {}}
      />
    )
    expect(screen.getByText("2 cables")).toBeTruthy()
    expect(screen.getByText("C-1")).toBeTruthy()
    expect(screen.getByText("C-2")).toBeTruthy()
  })
})
