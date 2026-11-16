// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"

import { FloorCanvas } from "./floor-canvas"
import { linkedTile } from "./placement"
import { usePlanEditState } from "./use-plan-edit-state"
import { useTileEdits } from "./use-tile-edits"

// Turning a tile on a free plan: the handle, the inspector's degrees and the
// 90° turn all turn it about its centre, onto a neighbour if need be (a free
// plan's tiles may overlap), as one undo step each.

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: vi.fn(() => new Promise(() => undefined)),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

beforeAll(() => {
  Element.prototype.setPointerCapture = () => {}
})
afterEach(cleanup)

const plan = {
  id: "p1",
  name: "Hall",
  grid_width: 20,
  grid_height: 12,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
  layout_mode: "free",
} as unknown as FloorPlan

const row = (id: string) => ({
  kind: "device" as const,
  id,
  name: id,
  rank: 0 as const,
  room: null,
  location: null,
  status: null,
  role: { id: "role1", name: "Access", color: "#0ea5e9" },
  photo: null,
  placed_count: 0,
  placed_on: [],
})

// A 3×1 device with a neighbour right under it: a quarter turn of the
// first stands it on the second.
const server: FloorPlanTile[] = [
  linkedTile(row("d1"), { x: 2, y: 2, width: 3, height: 1 }, "t1", "icon"),
  linkedTile(row("d2"), { x: 2, y: 3, width: 3, height: 1 }, "t2", "icon"),
]
const NO_SHAPES: never[] = []

function setup(p: FloorPlan = plan) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => {
      const ed = usePlanEditState("p1", server, NO_SHAPES)
      const edits = useTileEdits({ id: "p1", plan: p, ed })
      return { ed, edits }
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    }
  )
}

const t1 = (r: ReturnType<typeof setup>["result"]) =>
  r.current.ed.tiles.find((t) => t.id === "t1")!

describe("turning a free tile", () => {
  it("turns onto a neighbour from the handle's patch", () => {
    const { result } = setup()
    // What the rotate handle sends past 45°: the footprint swapped.
    act(() =>
      result.current.edits.changeTileGuarded("t1", {
        x: 3,
        y: 1,
        width: 1,
        height: 3,
        orientation: 60,
      })
    )
    expect(t1(result)).toMatchObject({
      x: 3,
      y: 1,
      width: 1,
      height: 3,
      orientation: 60,
    })
  })

  it("moves onto a neighbour", () => {
    const { result } = setup()
    act(() => result.current.edits.changeTileGuarded("t1", { x: 2, y: 2.5 }))
    expect(t1(result)).toMatchObject({ x: 2, y: 2.5 })
  })

  it("still refuses a stack on a grid plan", () => {
    const { result } = setup({ ...plan, layout_mode: "grid" })
    act(() => result.current.edits.changeTileGuarded("t1", { x: 2, y: 3 }))
    expect(t1(result)).toMatchObject({ x: 2, y: 2 })
  })

  it("takes any degree about its centre, as one undo step", async () => {
    const { result } = setup()
    act(() => result.current.edits.setTileFacing(t1(result), 30))
    expect(t1(result)).toMatchObject({
      x: 2,
      y: 2,
      width: 3,
      height: 1,
      orientation: 30,
    })
    // Past 45° the footprint swaps about the centre (3.5, 2.5).
    act(() => result.current.edits.setTileFacing(t1(result), 100))
    expect(t1(result)).toMatchObject({
      x: 3,
      y: 1,
      width: 1,
      height: 3,
      orientation: 100,
    })
    // Back to 0 from a turned tile: the quarter turn is the same, no swap.
    // Each edit is its own step once its event is over.
    await act(async () => result.current.edits.setTileFacing(t1(result), 30))
    await act(async () => result.current.edits.setTileFacing(t1(result), 0))
    expect(t1(result)).toMatchObject({ width: 3, height: 1, orientation: 0 })
    await act(async () => {
      result.current.ed.draft.undo()
    })
    expect(t1(result).orientation).toBe(30)
  })

  it("turns 90° from any angle", () => {
    const { result } = setup()
    act(() => result.current.edits.setTileFacing(t1(result), 20))
    act(() => result.current.edits.rotateTile(t1(result)))
    expect(t1(result)).toMatchObject({
      orientation: 110,
      width: 1,
      height: 3,
    })
  })
})

describe("the popover on a free plan being edited", () => {
  it("hangs under the tile, clear of its turn handle", () => {
    const onHoverTile = vi.fn()
    const { container } = render(
      <FloorCanvas
        plan={plan}
        tiles={[server[0]]}
        selectedId="t1"
        editable
        showGrid
        armed={null}
        mode="layout"
        onHoverTile={onHoverTile}
      />
    )
    expect(container.querySelector('[data-handle="rotate"]')).toBeTruthy()
    const g = container.querySelector('g[role="img"]')!
    fireEvent.pointerEnter(g, { clientX: 100, clientY: 100 })
    const at = onHoverTile.mock.calls.at(-1)?.[1]
    expect(at?.below).toBe(true)
  })
})
