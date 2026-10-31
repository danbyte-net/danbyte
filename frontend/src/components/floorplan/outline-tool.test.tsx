// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useImperativeHandle, forwardRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import { mapTile } from "./outline-detect.fixtures"
import { OutlinePanel, OutlinePreview, useOutlineDetect } from "./outline-tool"
import type { OutlineDetect } from "./outline-tool"
import type { AreaShape } from "./shapes"
import { toolForKey, TOOLS } from "./tool-rail"
import type { StructShape, WallRow } from "./structure"
import type { CadDrawingState } from "./use-cad-drawing"
import { usePlanEditState } from "./use-plan-edit-state"
import type { PlanEditState } from "./use-plan-edit-state"
import { useShapeEdits } from "./use-shape-edits"
import { useStructureEdits } from "./use-structure-edits"

// Detect outline in the editor: the tool and its key, a click proposing an
// outline over the plan, the card's settings, Accept and Accept + walls
// (one undo step each), Shift-click batches, Enter and Esc, and the CAD
// pick from the server.

const { apiMock, tile } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  tile: { current: null as ReturnType<typeof mapTile> | null },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("./outline-client", async (orig) => ({
  ...(await orig<object>()),
  // The background as pixels: the map tile, 240 × 180, over a 48 × 36
  // grid - 5 pixels a cell.
  loadPicture: vi.fn(async () => tile.current!.raster),
}))

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

const plan = {
  id: "p1",
  kind: "plan",
  grid_width: 48,
  grid_height: 36,
  cell_mm: 1000,
  layout_mode: "grid",
  background_image: "/media/bg.png",
  snapshot: null,
} as unknown as FloorPlan

interface Handle {
  od: OutlineDetect
  ed: PlanEditState
}

function makeHarness(p: FloorPlan, cad: CadDrawingState) {
  return forwardRef<Handle>(function Harness(_, ref) {
    const ed = usePlanEditState("p1", [], [], [])
    const structure = useStructureEdits({ id: "p1", plan: p, ed })
    const shapeEdits = useShapeEdits({ plan: p, ed })
    const od = useOutlineDetect({ plan: p, cad, ed, shapeEdits, structure })
    useImperativeHandle(ref, () => ({ od, ed }))
    return (
      <>
        <OutlinePanel od={od} />
        <svg>
          <g>
            <OutlinePreview od={od} />
          </g>
        </svg>
      </>
    )
  })
}

const NO_CAD = { drawing: null } as unknown as CadDrawingState

function setup(p: FloorPlan = plan, cad: CadDrawingState = NO_CAD) {
  const Harness = makeHarness(p, cad)
  const h: { current: Handle | null } = { current: null }
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <Harness ref={h} />
    </QueryClientProvider>
  )
  return h as { current: Handle }
}

/** A click with the tool at a cell. */
async function click(
  h: { current: Handle },
  cell: [number, number],
  shiftKey = false
) {
  await act(async () => {
    h.current.od.pick({ x: cell[0] * CELL, y: cell[1] * CELL }, { shiftKey })
    await new Promise((r) => setTimeout(r, 0))
  })
}

const areasOf = (ed: PlanEditState) =>
  ed.shapes.filter((s): s is AreaShape => s.kind === "area")
const wallsOf = (ed: { structure: StructShape[] }) =>
  ed.structure.filter((r): r is WallRow => r.part === "wall")

afterEach(cleanup)
beforeEach(() => {
  tile.current = mapTile()
  apiMock.mockReset()
  window.localStorage.clear()
})

describe("the tool", () => {
  it("is on the rail under O", () => {
    expect(TOOLS.find((t) => t.tool === "outline")?.label).toBe(
      "Detect outline"
    )
    expect(toolForKey("o", false)).toBe("outline")
  })

  it("shows its card only while in hand, with the hint", () => {
    const h = setup()
    expect(document.querySelector("[data-part=outline-panel]")).toBeNull()
    act(() => h.current.ed.setTool("outline"))
    expect(screen.getByText(/Click a building or room/)).toBeTruthy()
    expect(
      screen.getByText("Works best on maps, CAD and line drawings")
    ).toBeTruthy()
    // A picture: Colour and Fill room; no drawing, no CAD shape.
    expect(screen.getByRole("button", { name: "Colour" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Fill room" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "CAD shape" })).toBeNull()
  })
})

describe("finding and accepting", () => {
  it("proposes the building's outline with its corners to drag", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [14, 14])
    const [o] = h.current.od.outlines
    expect(o.points).toHaveLength(4)
    expect(screen.getByText(/4 corners/)).toBeTruthy()
    // 80 × 46 px at 5 px a cell, 1 m cells: about 147 m².
    const m2 = Number(/· ([\d.]+) m²/.exec(document.body.textContent)![1])
    expect(m2).toBeGreaterThan(140)
    expect(m2).toBeLessThan(150)
    expect(document.querySelectorAll("[data-outline-handle]")).toHaveLength(4)
    // Square: right angles. Off: the contour's own corners.
    const rightAngled = (pts: [number, number][]) =>
      pts.every((p, i) => {
        const a = pts[(i + pts.length - 1) % pts.length]
        const b = pts[(i + 1) % pts.length]
        const dot =
          (a[0] - p[0]) * (b[0] - p[0]) + (a[1] - p[1]) * (b[1] - p[1])
        return Math.abs(dot) < 1e-6
      })
    expect(rightAngled(h.current.od.outlines[0].points)).toBe(true)
    fireEvent.click(screen.getByRole("switch"))
    expect(rightAngled(h.current.od.outlines[0].points)).toBe(false)
    act(() => h.current.od.setSimplify(0))
    expect(h.current.od.outlines[0].points.length).toBeGreaterThanOrEqual(4)
  })

  it("Accept makes one polygon area, selected, as one undo step", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [14, 14])
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    const [a] = areasOf(h.current.ed)
    expect(a.shape).toBe("polygon")
    expect(a.points).toHaveLength(4)
    expect(h.current.ed.selectedShapeId).toBe(a.id)
    expect(h.current.ed.tool).toBe("select")
    expect(h.current.ed.dirtyIds.has(a.id)).toBe(true)
    act(() => void h.current.ed.draft.undo())
    expect(areasOf(h.current.ed)).toHaveLength(0)
    expect(h.current.ed.draft.canUndo).toBe(false)
  })

  it("Accept + walls walls it round, linked, in the same step", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [14, 14])
    fireEvent.click(screen.getByRole("button", { name: "Accept + walls" }))
    const [a] = areasOf(h.current.ed)
    const walls = wallsOf(h.current.ed)
    expect(walls).toHaveLength(1)
    expect(walls[0].source_area).toBe(a.id)
    // One closed wall on the outline's four corners.
    expect(walls[0].points).toHaveLength(5)
    act(() => void h.current.ed.draft.undo())
    expect(areasOf(h.current.ed)).toHaveLength(0)
    expect(wallsOf(h.current.ed)).toHaveLength(0)
  })

  it("Shift-click adds to the batch; each accepted outline is its own step", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [14, 14])
    await click(h, [40, 8], true)
    expect(h.current.od.outlines.map((o) => o.points.length)).toEqual([4, 6])
    expect(screen.getByText(/2 outlines · 10 corners/)).toBeTruthy()
    // A plain click starts again.
    await click(h, [40, 8])
    expect(h.current.od.outlines).toHaveLength(1)
    await click(h, [14, 14], true)
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(areasOf(h.current.ed)).toHaveLength(2)
    act(() => void h.current.ed.draft.undo())
    expect(areasOf(h.current.ed)).toHaveLength(1)
    act(() => void h.current.ed.draft.undo())
    expect(areasOf(h.current.ed)).toHaveLength(0)
  })

  it("Enter accepts and Esc cancels", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [14, 14])
    fireEvent.keyDown(window, { key: "Escape" })
    expect(h.current.od.outlines).toHaveLength(0)
    expect(h.current.ed.tool).toBe("outline")
    await click(h, [14, 14])
    fireEvent.keyDown(window, { key: "Enter" })
    expect(areasOf(h.current.ed)).toHaveLength(1)
  })

  it("says why when nothing is found", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [1, 1])
    expect(screen.getByText(/lower the tolerance/)).toBeTruthy()
    expect(h.current.od.outlines).toHaveLength(0)
  })

  it("a moved corner stays until the settings change", async () => {
    const h = setup()
    act(() => h.current.ed.setTool("outline"))
    await click(h, [14, 14])
    act(() => h.current.od.moveCorner(h.current.od.outlines[0].id, 0, [5, 5]))
    expect(h.current.od.outlines[0].points[0]).toEqual([5, 5])
    act(() => h.current.od.setSimplify(0.5))
    expect(h.current.od.outlines[0].points[0]).not.toEqual([5, 5])
  })
})

describe("on a CAD drawing", () => {
  it("picks the drawing's closed shape from the server", async () => {
    apiMock.mockResolvedValue({
      points: [
        [2, 2],
        [10, 2],
        [10, 7],
        [2, 7],
      ],
      layer: "WALLS",
    })
    const cad = { drawing: { status: "ready" } } as unknown as CadDrawingState
    const h = setup({ ...plan, background_image: null }, cad)
    act(() => h.current.ed.setTool("outline"))
    await click(h, [5, 4])
    expect(apiMock).toHaveBeenCalledWith(
      "/api/floor-plans/p1/drawing/loops/?x=5.0000&y=4.0000"
    )
    expect(h.current.od.outlines[0].points).toHaveLength(4)
    // Exact corners: no simplify or square for a drawing's shape.
    expect(screen.queryByRole("switch")).toBeNull()
    expect(screen.getByText(/4 corners · 40\.0 m²/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(areasOf(h.current.ed)[0].points).toEqual([
      [2, 2],
      [10, 2],
      [10, 7],
      [2, 7],
    ])
  })

  it("says so when no closed shape holds the click", async () => {
    const { ApiError } = await import("@/lib/api")
    apiMock.mockRejectedValue(
      new ApiError(404, { detail: "No closed shape here." })
    )
    const cad = { drawing: { status: "ready" } } as unknown as CadDrawingState
    const h = setup({ ...plan, background_image: null }, cad)
    act(() => h.current.ed.setTool("outline"))
    await click(h, [5, 4])
    expect(screen.getByText("No closed shape here")).toBeTruthy()
  })
})
