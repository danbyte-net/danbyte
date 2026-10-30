// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { FloorPlan, FloorPlanBulkPayload, FloorPlanTile } from "@/lib/api"

import { linkedTile } from "./placement"
import { usePlanEditState } from "./use-plan-edit-state"
import { useTileEdits } from "./use-tile-edits"

// Save sends the version each edit is based on; a 409 opens the conflict
// rows instead of a toast, and "Keep mine" / "Take theirs" settle them and
// save again. Placing from the picker makes linked tiles with no type.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const plan = {
  id: "p1",
  grid_width: 10,
  grid_height: 10,
  cell_mm: 600,
  layout_mode: "grid",
} as unknown as FloorPlan

const ROW = {
  kind: "device" as const,
  id: "d1",
  name: "sw1",
  rank: 0 as const,
  room: null,
  location: null,
  status: null,
  role: { id: "role1", name: "Access", color: "#0ea5e9" },
  photo: null,
  placed_count: 0,
  placed_on: [],
}
const server: FloorPlanTile[] = [
  {
    ...linkedTile(ROW, { x: 1, y: 1, width: 1, height: 1 }, "t1", "icon"),
    updated_at: "2026-10-30T10:00:00.000001Z",
  },
]

const NO_SHAPES: never[] = []

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => {
      const ed = usePlanEditState("p1", server, NO_SHAPES)
      const edits = useTileEdits({ id: "p1", plan, ed })
      return { ed, edits }
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    }
  )
}

const sent = (n: number) =>
  JSON.parse(String(apiMock.mock.calls[n][1]?.body)) as FloorPlanBulkPayload

beforeEach(() => apiMock.mockReset())

describe("saving with versions", () => {
  it("sends the version an edit is based on", async () => {
    apiMock.mockResolvedValue({ tiles: server, areas: [], labels: [] })
    const { result } = setup()
    act(() => result.current.edits.changeTile("t1", { x: 3 }))
    act(() => result.current.edits.save.mutate())
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(sent(0).tiles?.update?.[0]).toMatchObject({
      id: "t1",
      x: 3,
      version: "2026-10-30T10:00:00.000001Z",
    })
  })

  it("a 409 lists the rows; Keep mine saves again on their version", async () => {
    const theirs = { ...server[0], x: 5, updated_at: "2026-10-30T11:00:00Z" }
    apiMock.mockRejectedValueOnce(
      new ApiError(409, {
        conflicts: [
          { kind: "tile", id: "t1", current: theirs, changed_by: "bob" },
        ],
      })
    )
    apiMock.mockResolvedValue({ tiles: server, areas: [], labels: [] })
    const { result } = setup()
    act(() => result.current.edits.changeTile("t1", { x: 3 }))
    act(() => result.current.edits.save.mutate())
    await waitFor(() => expect(result.current.edits.conflicts).toHaveLength(1))
    act(() => result.current.edits.resolveConflicts({ t1: "mine" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))
    expect(sent(1).tiles?.update?.[0]).toMatchObject({
      id: "t1",
      x: 3,
      version: "2026-10-30T11:00:00Z",
    })
  })

  it("Take theirs drops the edit and keeps the row as it is now", async () => {
    const theirs = { ...server[0], x: 5, updated_at: "2026-10-30T11:00:00Z" }
    apiMock.mockRejectedValueOnce(
      new ApiError(409, {
        conflicts: [
          { kind: "tile", id: "t1", current: theirs, changed_by: "" },
        ],
      })
    )
    apiMock.mockResolvedValue({ tiles: [theirs], areas: [], labels: [] })
    const { result } = setup()
    act(() => result.current.edits.changeTile("t1", { x: 3 }))
    act(() => result.current.edits.save.mutate())
    await waitFor(() => expect(result.current.edits.conflicts).toHaveLength(1))
    act(() => result.current.edits.resolveConflicts({ t1: "theirs" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))
    expect(sent(1).tiles?.update).toEqual([])
    expect(result.current.ed.tiles[0].x).toBe(5)
  })
})

describe("placing from the picker", () => {
  it("makes linked tiles with no type, in a row, one undo step", () => {
    const { result } = setup()
    act(() => {
      result.current.edits.placeRows(
        [
          { ...ROW, id: "d2", name: "sw2" },
          { ...ROW, id: "d3", name: "sw3" },
        ],
        [1.5, 1.5]
      )
    })
    const placed = result.current.ed.tiles.filter((t) => t.id !== "t1")
    expect(placed.map((t) => [t.x, t.y, t.linked?.id])).toEqual([
      [2, 1, "d2"],
      [3, 1, "d3"],
    ])
    expect(placed.every((t) => !t.tile_type && !t.role_type)).toBe(true)
    act(() => {
      result.current.ed.draft.undo()
    })
    expect(result.current.ed.tiles).toHaveLength(1)
  })

  it("never places an object twice: a lone drop moves its tile", () => {
    const { result } = setup()
    // d1 stands on the saved tile t1: dropping it moves that tile.
    act(() => {
      result.current.edits.placeRows([ROW], [6.5, 4.5], { move: true })
    })
    expect(result.current.ed.tiles).toHaveLength(1)
    expect(result.current.ed.tiles[0]).toMatchObject({ id: "t1", x: 6, y: 4 })
    expect(result.current.ed.selectedId).toBe("t1")
    // A click (no move) only selects it.
    act(() => {
      result.current.edits.placeRows([ROW], [0.5, 0.5])
    })
    expect(result.current.ed.tiles[0]).toMatchObject({ x: 6, y: 4 })
  })

  it("counts the unsaved draft: a tile placed a moment ago is not placed again", () => {
    const { result } = setup()
    const d2 = { ...ROW, id: "d2", name: "sw2" }
    act(() => {
      result.current.edits.placeRows([d2], [3.5, 3.5])
    })
    act(() => {
      result.current.edits.placeRows([d2], [7.5, 7.5], { move: true })
    })
    const d2Tiles = result.current.ed.tiles.filter((t) => t.linked?.id === "d2")
    expect(d2Tiles).toHaveLength(1)
    expect(d2Tiles[0]).toMatchObject({ x: 7, y: 7 })
  })

  it("several at once skip those already on the floor, saying how many", () => {
    vi.mocked(toast.info).mockClear()
    const { result } = setup()
    act(() => {
      result.current.edits.placeRows(
        [ROW, { ...ROW, id: "d2", name: "sw2" }],
        [4.5, 4.5]
      )
    })
    expect(result.current.ed.tiles.map((t) => t.linked?.id)).toEqual([
      "d1",
      "d2",
    ])
    expect(toast.info).toHaveBeenCalledWith("1 already on this floor, skipped")
  })

  it("carries the row's photo into the draft, so it can show at once", () => {
    const { result } = setup()
    const photo = {
      url: "/m/front.png",
      aspect: 0.25,
      source: "type" as const,
      width_mm: 440,
    }
    act(() => {
      result.current.edits.placeRows(
        [{ ...ROW, id: "d2", name: "sw2", photo }],
        [5.5, 5.5]
      )
    })
    const t = result.current.ed.tiles.find((x) => x.linked?.id === "d2")!
    expect(t.photo).toEqual(photo)
    // A grid plan shows it in the tile's cells, size unchanged.
    act(() => result.current.edits.setTileDisplay(t, "photo"))
    const shown = result.current.ed.tiles.find((x) => x.id === t.id)!
    expect(shown).toMatchObject({ display: "photo", width: 1, height: 1 })
  })
})
