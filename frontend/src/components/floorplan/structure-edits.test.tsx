// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { FloorPlan, FloorPlanBulkPayload } from "@/lib/api"

import type { AreaShape, PlanShape } from "./shapes"
import { structureOf } from "./structure"
import type { StructShape } from "./structure"
import { usePlanEditState } from "./use-plan-edit-state"
import { useStructureEdits } from "./use-structure-edits"
import { useTileEdits } from "./use-tile-edits"

// Walls, doors, trays and raised floors live in the editor's draft: "Add
// walls around" is one undo step and one save, a door added and flipped,
// a split and a join undo as steps, and Save sends each row's version - a
// wall changed elsewhere is a 409 settled like a tile.

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
  grid_width: 20,
  grid_height: 12,
  cell_mm: 600,
  layout_mode: "grid",
} as unknown as FloorPlan

const room = (id: string, x: number): AreaShape => ({
  kind: "area",
  id,
  shape: "rect",
  x,
  y: 2,
  width: 4,
  height: 3,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "2026-10-30T10:00:00Z",
})

const SHAPES: PlanShape[] = [room("a1", 2), room("a2", 6)]
const WALL = {
  id: "w1",
  label: "",
  points: [
    [0, 8],
    [6, 8],
  ] as [number, number][],
  height_mm: null,
  thickness_mm: null,
  color: "",
  openings: [],
  created_at: "",
  updated_at: "2026-10-30T10:00:00.000001Z",
}
const STRUCTURE: StructShape[] = structureOf([WALL], [], [])
const NO_TILES: never[] = []

function setup(structure = STRUCTURE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => {
      const ed = usePlanEditState("p1", NO_TILES, SHAPES, structure)
      const edits = useTileEdits({ id: "p1", plan, ed })
      const structureEdits = useStructureEdits({
        id: "p1",
        plan,
        ed,
        onVersion: edits.rebaseVersion,
      })
      return { ed, edits, s: structureEdits }
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
const walls = (ed: { structure: StructShape[] }) =>
  ed.structure.filter((r) => r.part === "wall")

beforeEach(() => {
  apiMock.mockReset()
  window.localStorage.clear()
})

describe("walls round areas", () => {
  it("is one undo step for two rooms, the shared side walled once", () => {
    const { result } = setup()
    act(() => result.current.s.wallsAroundAreas(["a1", "a2"]))
    expect(walls(result.current.ed)).toHaveLength(3)
    expect(result.current.ed.isDirty).toBe(true)
    act(() => {
      result.current.ed.draft.undo()
    })
    expect(walls(result.current.ed)).toHaveLength(1)
    expect(result.current.ed.isDirty).toBe(false)
  })

  it("takes the thickness last given to a wall", () => {
    const { result } = setup()
    act(() => result.current.s.patchWall("w1", { thickness_mm: 240 }))
    act(() => result.current.s.wallsAroundAreas(["a1"]))
    const made = walls(result.current.ed).find((w) => w.id !== "w1")
    expect(made && made.part === "wall" && made.thickness_mm).toBe(240)
  })

  it("saves them with the plan, in one bulk call", async () => {
    apiMock.mockResolvedValue({
      tiles: [],
      areas: [],
      labels: [],
      walls: [WALL],
      raised_floors: [],
      tray_rows: [],
    })
    const { result } = setup()
    act(() => result.current.s.wallsAroundAreas(["a1"]))
    act(() => result.current.edits.save.mutate())
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    const body = sent(0)
    expect(body.walls?.create).toHaveLength(1)
    expect(body.walls?.create?.[0].points).toEqual([
      [2, 2],
      [6, 2],
      [6, 5],
      [2, 5],
      [2, 2],
    ])
    expect(body.walls?.update).toEqual([])
  })
})

describe("doors, splits and joins in the draft", () => {
  it("adds a door, flips it, and undoes each as a step", async () => {
    const { result } = setup()
    // Each in its own task, as two clicks are.
    await act(async () => result.current.s.addDoor("w1", 0, 1, 3))
    const door = () => {
      const w = result.current.ed.structure.find((r) => r.id === "w1")
      return w?.part === "wall" ? w.openings[0] : undefined
    }
    expect(door()).toMatchObject({ from: 1, to: 3, hinge: "start" })
    expect(result.current.ed.selectedDoor).toEqual({ wallId: "w1", index: 0 })
    await act(async () => result.current.s.flipDoor("w1", 0))
    expect(door()).toMatchObject({ hinge: "start", side: "right" })
    act(() => {
      result.current.ed.draft.undo()
    })
    expect(door()).toMatchObject({ side: "left" })
  })

  it("splits a wall and joins it back", async () => {
    const { result } = setup()
    await act(async () => result.current.s.splitAt("w1", 0, 3))
    expect(walls(result.current.ed)).toHaveLength(2)
    const [a, b] = walls(result.current.ed)
    await act(async () => result.current.s.join(a.id, b.id))
    const after = walls(result.current.ed)
    expect(after).toHaveLength(1)
    expect(after[0].points).toEqual([
      [0, 8],
      [3, 8],
      [6, 8],
    ])
    // One step back: split again; two: the wall as loaded.
    act(() => {
      result.current.ed.draft.undo()
    })
    expect(walls(result.current.ed)).toHaveLength(2)
    act(() => {
      result.current.ed.draft.undo()
    })
    expect(walls(result.current.ed)).toHaveLength(1)
    expect(walls(result.current.ed)[0].points).toEqual(WALL.points)
  })

  it("a wall changed elsewhere is a 409; Keep mine saves on their version", async () => {
    const theirs = {
      ...WALL,
      label: "Theirs",
      updated_at: "2026-10-30T11:00:00Z",
    }
    apiMock.mockRejectedValueOnce(
      new ApiError(409, {
        conflicts: [
          { kind: "wall", id: "w1", current: theirs, changed_by: "bob" },
        ],
      })
    )
    apiMock.mockResolvedValue({
      tiles: [],
      areas: [],
      labels: [],
      walls: [theirs],
      raised_floors: [],
      tray_rows: [],
    })
    const { result } = setup()
    act(() =>
      result.current.s.patchWall("w1", {
        points: [
          [0, 8],
          [7, 8],
        ],
      })
    )
    act(() => result.current.edits.save.mutate())
    await waitFor(() => expect(result.current.edits.conflicts).toHaveLength(1))
    expect(sent(0).walls?.update?.[0]).toMatchObject({
      id: "w1",
      version: WALL.updated_at,
    })
    act(() => result.current.edits.resolveConflicts({ w1: "mine" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))
    expect(sent(1).walls?.update?.[0]).toMatchObject({
      id: "w1",
      version: "2026-10-30T11:00:00Z",
      points: [
        [0, 8],
        [7, 8],
      ],
    })
  })

  it("a deleted wall goes with its kind and version", async () => {
    apiMock.mockResolvedValue({
      tiles: [],
      areas: [],
      labels: [],
      walls: [],
      raised_floors: [],
      tray_rows: [],
    })
    const { result } = setup()
    act(() => result.current.s.deleteRow("w1"))
    act(() => result.current.edits.save.mutate())
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    expect(sent(0).walls?.delete).toEqual([
      { id: "w1", version: WALL.updated_at },
    ])
  })
})
