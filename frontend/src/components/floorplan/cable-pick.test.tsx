// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import * as draw from "./cable-draw"
import { CableLayer } from "./cable-layer"
import { CablePickIndex, orderHits } from "./cable-pick"
import type { Pt } from "./cable-route"
import { FloorCanvas } from "./floor-canvas"
import { routeEnds } from "./plan-label-pass"
import testmap from "./cable-pick.testmap.json"

// One hit-test for the cables (cable-pick.ts): a click where several
// cables meet asks which, one alone opens at once, a tile keeps its own
// click. The geometry is testmap's, as /api/floor-plans/{id}/cable-paths/
// and /contents/ returned it: ten stubs, six of them fanning out of
// aalborg-core1, and the two runs sw1 to core1 (#1271, #1272). A click
// among core1's stubs at fit zoom opened Cable #1270 straight away.

afterEach(cleanup)
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
Element.prototype.hasPointerCapture = () => false
Element.prototype.scrollIntoView = () => {}

const CELL = 40
// The fixture predates the plan's saved view state.
const plan = { state: {}, ...testmap.plan } as unknown as FloorPlan
const tiles = testmap.tiles as unknown as FloorPlanTile[]
const trays = testmap.trays as unknown as FloorPlanTray[]
const cables = testmap.cables as unknown as FloorPlanCablePath[]
const routes = new draw.CableRouteCache().routes(cables, {
  trays,
  tiles,
  ceilingMm: plan.ceiling_mm,
})
const stubs = draw.cableStubs(cables, routes, tiles, [
  plan.grid_width / 2,
  plan.grid_height / 2,
])
const CORE = "c07f4862-0e92-4205-bf47-5d1aa642b046"
const core = tiles.find((t) => t.id === CORE)!
const idOf = (label: string) => cables.find((c) => c.label === label)!.id
const labelOf = (id: string) => cables.find((c) => c.id === id)?.label
const RUNS = [idOf("Cable #1271"), idOf("Cable #1272")]
const coreStubs = stubs.filter((s) => s.tile === CORE).map((s) => s.id)

/** testmap fitted to a 1600 x 1000 canvas: 3 px a cell. */
const FIT = 0.075
/** Mid zoom: 24 px a cell. */
const MID = 0.6

function layer(
  k: number,
  at: Pt,
  patch: Partial<React.ComponentProps<typeof CableLayer>> = {}
) {
  const onSelect = vi.fn()
  const onChoose = vi.fn()
  const onPlan = vi.fn()
  const r = render(
    <svg onPointerDown={onPlan}>
      <CableLayer
        cablePaths={cables}
        routes={routes}
        k={k}
        cellMm={plan.cell_mm}
        colorBy="status"
        bundle
        showLabels
        highlightIds={[]}
        interactive
        onSelect={onSelect}
        onHover={() => {}}
        onChoose={onChoose}
        stubs={stubs}
        tiles={tiles}
        toPlan={() => at}
        {...patch}
      />
    </svg>
  )
  const click = () =>
    fireEvent.pointerDown(r.container.querySelector("[data-part=pick]")!, {
      button: 0,
      clientX: 10,
      clientY: 20,
    })
  /** The ids the chooser was asked for, by label. */
  const chosen = () =>
    (onChoose.mock.calls.at(-1)?.[0] as string[] | undefined)?.map(labelOf)
  return { ...r, onSelect, onChoose, onPlan, click, chosen }
}

/** `px` screen px out of a tile's centre through point `p`, past `p`. */
const outFrom = (p: Pt, px: number, k: number): Pt => {
  const c: Pt = [core.x + core.width / 2, core.y + core.height / 2]
  const d: Pt = [p[0] - c[0], p[1] - c[1]]
  const n = Math.hypot(...d)
  const s = px / (CELL * k)
  return [p[0] + (d[0] / n) * s, p[1] + (d[1] / n) * s]
}
/** `px` screen px along a stub from its start. */
const alongStub = (id: string, px: number, k: number): Pt => {
  const s = stubs.find((x) => x.id === id)!
  const c = px / (CELL * k)
  return [s.from[0] + s.dir[0] * c, s.from[1] + s.dir[1] * c]
}

describe("the fixture", () => {
  it("is testmap: ten stubs, six off core1, and the two runs", () => {
    expect(stubs).toHaveLength(10)
    expect(coreStubs).toHaveLength(6)
    expect(routes.has(RUNS[0]) && routes.has(RUNS[1])).toBe(true)
  })
})

describe("one hit-test for the cables", () => {
  it("several stubs within the radius: the chooser lists them all", () => {
    // Just out of core1 at fit zoom, among its fan of stubs.
    const s = stubs.find((x) => x.tile === CORE)!
    const { click, onChoose, onSelect, onPlan, chosen } = layer(
      FIT,
      outFrom(s.from, 3, FIT)
    )
    click()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose.mock.calls[0][1]).toEqual({ x: 10, y: 20 })
    const ids: string[] = onChoose.mock.calls[0][0]
    for (const id of coreStubs) expect(ids).toContain(id)
    // The run to sw1 leaves core1 there too.
    expect(chosen()).toEqual(
      expect.arrayContaining(["Cable #1270", "Cable #1271", "Cable #1272"])
    )
    // The plan does not also take the press (pan, deselect).
    expect(onPlan).not.toHaveBeenCalled()
  })

  it("a bundle: its members, nearest first then by label", () => {
    const { click, onSelect, chosen, container } = layer(MID, [225, 148.5])
    expect(container.querySelector("[data-bundle]")).not.toBeNull()
    click()
    expect(onSelect).not.toHaveBeenCalled()
    expect(chosen()).toEqual(["Cable #1271", "Cable #1272"])
  })

  it("one cable alone opens at once", () => {
    const zz = idOf("zz15-coax")
    const { click, onSelect, onChoose } = layer(MID, alongStub(zz, 14, MID))
    click()
    expect(onSelect).toHaveBeenCalledWith(zz)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it("a run and a stub over each other: both listed", () => {
    // Of core1's stubs, the one leaving left along the runs to sw1.
    const left = stubs
      .filter((s) => s.tile === CORE)
      .sort((a, b) => a.dir[0] - b.dir[0])[0]
    const { click, onChoose } = layer(MID, alongStub(left.id, 10, MID))
    click()
    const ids: string[] = onChoose.mock.calls[0][0]
    expect(ids).toContain(left.id)
    expect(ids).toContain(RUNS[0])
    expect(ids).toContain(RUNS[1])
    // Nearest first: the stub under the pointer before the runs beside it.
    expect(ids[0]).toBe(left.id)
  })

  it("a click on a tile is the tile's: no cable, no chooser", () => {
    // Inside core1, where its runs start and its stubs leave.
    const { click, onSelect, onChoose, onPlan } = layer(MID, [
      core.x + 0.5,
      core.y + 0.45,
    ])
    click()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onChoose).not.toHaveBeenCalled()
    // The press goes on, to what is under the layer.
    expect(onPlan).toHaveBeenCalled()
  })

  it("an end dot on a tile's edge is the cable's", () => {
    const cp = cables.find((c) => c.id === RUNS[0])!
    const rect = (id: string) => {
      const t = tiles.find((x) => x.id === id)
      return t ? { x: t.x, y: t.y, w: t.width, h: t.height } : null
    }
    const ends = routeEnds(cp, routes.get(RUNS[0])!, rect)
    const dot = ends.find((e) => e.tile === CORE)!.at
    // Two px inside the tile from the dot where the traced run leaves it.
    const inside: Pt = [dot[0] + 2 / (CELL * MID), dot[1]]
    expect(inside[0]).toBeGreaterThan(core.x)
    const traced = layer(MID, inside, { highlightIds: [RUNS[0]] })
    expect(
      traced.container.querySelector("[data-part=pick] circle")
    ).not.toBeNull()
    traced.click()
    // A traced cable's click lets it go.
    expect(traced.onSelect).toHaveBeenCalledWith(null)
    expect(traced.onPlan).not.toHaveBeenCalled()
    cleanup()
    // Not traced, no dot drawn: the tile's.
    const plain = layer(MID, inside)
    plain.click()
    expect(plain.onSelect).not.toHaveBeenCalled()
    expect(plain.onChoose).not.toHaveBeenCalled()
  })

  it("draws one pick target; the cables' own elements take no pointer", () => {
    const { container } = layer(MID, [0, 0])
    expect(container.querySelectorAll("[data-part=pick]")).toHaveLength(1)
    for (const el of container.querySelectorAll(
      "[data-cable], [data-bundle], [data-stub], [data-short], [data-lifted]"
    ))
      expect(el.getAttribute("pointer-events")).toBe("none")
  })
})

describe("dedupe and order", () => {
  it("lists each cable once, nearest first, then by label", () => {
    const shapes = [
      // One cable drawn as a lane, a bundle and a stub: one hit.
      { id: "b", pts: [[0, 0] as Pt, [10, 0] as Pt] },
      { id: "b", pts: [[0, 0.01] as Pt, [10, 0.01] as Pt], group: "g" },
      { id: "b", pts: [[5, 0] as Pt, [5, 5] as Pt] },
      { id: "a", pts: [[0, 0.05] as Pt, [10, 0.05] as Pt], group: "g" },
      { id: "c", pts: [[0, 0.15] as Pt, [10, 0.15] as Pt] },
      { id: "far", pts: [[0, 3] as Pt, [10, 3] as Pt] },
    ]
    const index = new CablePickIndex(shapes, [], 40)
    const hits = index.query([5, 0], 6)
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b", "c"])
    expect(hits.find((h) => h.id === "b")!.groups).toEqual(["g"])
    const labels: Record<string, string> = {
      a: "Cable #10",
      b: "Cable #9",
      c: "Cable #1",
    }
    // a and b within a pixel of each other: by label, naturally (#9 < #10).
    expect(orderHits(hits, (id) => labels[id]).map((h) => h.id)).toEqual([
      "b",
      "a",
      "c",
    ])
  })

  it("the chooser keeps a click's order and lists each cable once", () => {
    const palette = draw.typePalette(cables)
    const ids = [RUNS[1], RUNS[0], RUNS[1]]
    const kept = draw.cableChoices(ids, cables, "status", palette, {
      keepOrder: true,
    })
    expect(kept.map((r) => r.label)).toEqual(["Cable #1272", "Cable #1271"])
    // A tray's list stays in lane order.
    expect(
      draw.cableChoices(ids, cables, "status", palette).map((r) => r.label)
    ).toEqual(["Cable #1271", "Cable #1272"])
  })
})

// ── The canvas, fitted as in a browser: View and edit ───────────────────────

function fittedCanvas(editable: boolean) {
  const rect = SVGElement.prototype.getBoundingClientRect
  SVGElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 1600,
    height: 1000,
    right: 1600,
    bottom: 1000,
    toJSON() {},
  })
  const onSelectCable = vi.fn()
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={tiles}
      selectedId={null}
      editable={editable}
      showGrid={false}
      armed={null}
      liveState={null}
      cablePaths={cables}
      cableRoutes={routes}
      cableStubs={stubs}
      showCableLinks
      bundleCables
      trays={trays}
      showTrays
      onSelectCable={onSelectCable}
    />
  )
  const restore = () => {
    SVGElement.prototype.getBoundingClientRect = rect
  }
  const g = r.container.querySelector("g[transform]")!
  const m = /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(
    g.getAttribute("transform")!
  )!
  const [tx, ty, k] = m.slice(1).map(Number)
  const clientAt = ([x, y]: Pt) => ({
    button: 0,
    clientX: tx + x * CELL * k,
    clientY: ty + y * CELL * k,
  })
  return { ...r, onSelectCable, restore, k, clientAt }
}

const rows = () =>
  [...document.querySelectorAll("[data-cable-choice]")].map((r) =>
    labelOf(r.getAttribute("data-cable-choice")!)
  )

describe.each([
  ["View", false],
  ["edit", true],
])("FloorCanvas pick in %s", (_name, editable) => {
  it("a click among core1's stubs asks which; a pick opens that cable", async () => {
    const c = fittedCanvas(editable)
    try {
      expect(c.k).toBeCloseTo(FIT, 3)
      const s = stubs.find((x) => x.tile === CORE)!
      await act(async () => {
        fireEvent.pointerDown(
          c.container.querySelector("[data-part=pick]")!,
          c.clientAt(outFrom(s.from, 3, c.k))
        )
      })
      const listed = rows()
      expect(listed.length).toBeGreaterThanOrEqual(8)
      for (const id of coreStubs) expect(listed).toContain(labelOf(id))
      expect(new Set(listed).size).toBe(listed.length)
      expect(c.onSelectCable).not.toHaveBeenCalled()
      // A row under the pointer: that cable alone on the plan, the rest
      // dimmed - a stub, and a run apart from its bundle.
      const items = screen.getAllByRole("menuitem")
      const row = items[0]
      const id = row.getAttribute("data-cable-choice")!
      fireEvent.pointerEnter(row)
      const stubEls = c.container.querySelectorAll("[data-stub]")
      for (const el of stubEls)
        expect(el.getAttribute("opacity")).toBe(
          el.getAttribute("data-stub") === id ? "1" : "0.2"
        )
      const run = items.find(
        (r) => r.getAttribute("data-cable-choice") === RUNS[0]
      )!
      fireEvent.pointerEnter(run)
      expect(
        c.container.querySelector(`[data-solo='${RUNS[0]}']`)
      ).not.toBeNull()
      fireEvent.pointerEnter(row)
      fireEvent.click(row)
      expect(c.onSelectCable).toHaveBeenCalledWith(
        row.getAttribute("data-cable-choice")
      )
    } finally {
      c.restore()
    }
  })
})
