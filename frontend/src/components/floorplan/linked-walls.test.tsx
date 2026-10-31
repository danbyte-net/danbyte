// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanBulkPayload } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { AreaWallsDeleteDialog, WallLinkCard } from "./linked-walls"
import type { AreaShape, PlanShape } from "./shapes"
import { StructureRail } from "./structure-panels"
import { areaOutline, structureOf } from "./structure"
import type { StructShape, WallRow } from "./structure"
import { StructureToolbar } from "./structure-toolbar"
import { TrayRail } from "./tray-panels"
import { usePlanEditState } from "./use-plan-edit-state"
import { useShapeEdits } from "./use-shape-edits"
import { useStructureEdits } from "./use-structure-edits"
import { useTileEdits } from "./use-tile-edits"

// Walls made from an area follow its outline exactly, are named after it
// and linked to it: the area carries them when it moves, offers to rebuild
// them when reshaped, and asks about them when deleted. Walls, doors, trays
// and raised floors each have a Delete on their toolbar and their row.

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

const area = (p: Partial<AreaShape> = {}): AreaShape => ({
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 2,
  y: 2,
  width: 4,
  height: 3,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "Cage",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "2026-10-30T10:00:00Z",
  ...p,
})

const NO_TILES: never[] = []
const NO_STRUCTURE: StructShape[] = []

function setup(shapes: PlanShape[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => {
      const ed = usePlanEditState("p1", NO_TILES, shapes, NO_STRUCTURE)
      const edits = useTileEdits({ id: "p1", plan, ed })
      const s = useStructureEdits({ id: "p1", plan, ed })
      const sh = useShapeEdits({ plan, ed })
      // As the editor wires it: an area's change carries its walls.
      const changeShape = (id: string, patch: Partial<PlanShape>) => {
        s.followArea(id, patch)
        sh.changeShape(id, patch)
      }
      return { ed, edits, s, changeShape, sh }
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    }
  )
}

const wallsOf = (ed: { structure: StructShape[] }) =>
  ed.structure.filter((r): r is WallRow => r.part === "wall")

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  window.localStorage.clear()
})

describe("walls from an outline, exactly", () => {
  it("puts the corners of a turned rectangle and a polygon on the outline", async () => {
    const turned = area({ rotation: 30 })
    const poly = area({
      id: "a2",
      shape: "polygon",
      label: "Bay",
      points: [
        [10.1, 1.3],
        [14.7, 1.3],
        [12.25, 5.05],
      ],
    })
    const { result } = setup([turned, poly])
    await act(async () => result.current.s.wallsAroundAreas(["a1", "a2"]))
    const [a, b] = wallsOf(result.current.ed)
    areaOutline(turned).forEach((c, i) => {
      expect(a.points[i][0]).toBeCloseTo(c[0], 3)
      expect(a.points[i][1]).toBeCloseTo(c[1], 3)
    })
    expect(b.points).toEqual([
      [10.1, 1.3],
      [14.7, 1.3],
      [12.25, 5.05],
      [10.1, 1.3],
    ])
  })
})

describe("walls named after their area and linked", () => {
  it("are called '<name> walls', linked by default; the card unlinks", async () => {
    const { result } = setup([area()])
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    const [w] = wallsOf(result.current.ed)
    expect(w.label).toBe("Cage walls")
    expect(w.source_area).toBe("a1")
    expect(result.current.s.linkChoice?.name).toBe("Cage")
    await act(async () => result.current.s.setLinked(false))
    expect(wallsOf(result.current.ed)[0].source_area).toBeNull()
    await act(async () => result.current.s.setLinked(true))
    expect(wallsOf(result.current.ed)[0].source_area).toBe("a1")
  })

  it("number the stretches when an existing wall splits the outline", async () => {
    const { result } = setup([area()])
    // Walls already along the middles of the top and bottom edges: two
    // stretches remain.
    await act(async () =>
      result.current.s.createWall([
        [3, 2],
        [5, 2],
      ])
    )
    await act(async () =>
      result.current.s.createWall([
        [3, 5],
        [5, 5],
      ])
    )
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    const labels = wallsOf(result.current.ed)
      .filter((w) => w.source_area)
      .map((w) => w.label)
    expect(labels).toEqual(["Cage walls 1", "Cage walls 2"])
  })

  it("move with their area, doors and all, in the same undo step", async () => {
    const { result } = setup([area()])
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    const id = wallsOf(result.current.ed)[0].id
    await act(async () => result.current.s.placeDoor(id, 0, 2))
    const before = wallsOf(result.current.ed)[0]
    await act(async () => result.current.changeShape("a1", { x: 3.5, y: 2.25 }))
    const after = wallsOf(result.current.ed)[0]
    expect(after.points[0]).toEqual([3.5, 2.25])
    expect(after.openings).toEqual(before.openings)
    act(() => {
      result.current.ed.draft.undo()
    })
    expect(wallsOf(result.current.ed)[0].points[0]).toEqual([2, 2])
    expect(result.current.ed.shapes[0]).toMatchObject({ x: 2, y: 2 })
  })

  it("stay put when unlinked", async () => {
    const { result } = setup([area()])
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    await act(async () =>
      result.current.s.unlinkWalls(wallsOf(result.current.ed).map((w) => w.id))
    )
    await act(async () => result.current.changeShape("a1", { x: 5 }))
    expect(wallsOf(result.current.ed)[0].points[0]).toEqual([2, 2])
  })

  it("a reshape offers Update walls, which keeps the door along its stretch", async () => {
    const { result } = setup([area()])
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    const id = wallsOf(result.current.ed)[0].id
    await act(async () => result.current.s.placeDoor(id, 0, 2))
    expect(result.current.s.wallsOffOutline("a1")).toBe(false)
    await act(async () => result.current.changeShape("a1", { width: 8 }))
    // A reshape does not move the walls; it offers to rebuild them.
    expect(wallsOf(result.current.ed)[0].points[1]).toEqual([6, 2])
    expect(result.current.s.wallsOffOutline("a1")).toBe(true)
    await act(async () => result.current.s.updateLinkedWalls("a1"))
    const w = wallsOf(result.current.ed)[0]
    expect(w.id).toBe(id)
    expect(w.label).toBe("Cage walls")
    expect(w.points[1]).toEqual([10, 2])
    expect(w.openings).toHaveLength(1)
    const o = w.openings[0]
    expect((o.from + o.to) / 2).toBeCloseTo((2 / 14) * 22, 2)
    expect(result.current.s.wallsOffOutline("a1")).toBe(false)
  })

  it("asks before dropping a door that no longer fits", async () => {
    const { result } = setup([area()])
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    const id = wallsOf(result.current.ed)[0].id
    await act(async () => result.current.s.addDoor(id, 0, 0.5, 3.5))
    await act(async () =>
      result.current.changeShape("a1", { width: 1, height: 1 })
    )
    await act(async () => result.current.s.updateLinkedWalls("a1"))
    expect(result.current.s.updateDrops?.doors).toEqual(["Cage walls: door 1"])
    // Nothing changed yet.
    expect(wallsOf(result.current.ed)[0].openings).toHaveLength(1)
    await act(async () => result.current.s.updateLinkedWalls("a1", true))
    expect(wallsOf(result.current.ed)[0].openings).toEqual([])
    expect(result.current.s.updateDrops).toBeNull()
  })

  it("deleting the area takes the walls, or keeps them unlinked", async () => {
    const { result } = setup([area()])
    await act(async () => result.current.s.wallsAroundAreas(["a1"]))
    await act(async () => {
      result.current.s.settleAreaWalls("a1", "keep")
      result.current.sh.deleteShape("a1")
    })
    expect(wallsOf(result.current.ed)[0].source_area).toBeNull()
    act(() => {
      result.current.ed.draft.undo()
    })
    await act(async () => {
      result.current.s.settleAreaWalls("a1", "delete")
      result.current.sh.deleteShape("a1")
    })
    expect(wallsOf(result.current.ed)).toEqual([])
  })

  it("saves the link with the new area's key", async () => {
    apiMock.mockResolvedValue({
      tiles: [],
      areas: [],
      labels: [],
      walls: [],
      raised_floors: [],
      tray_rows: [],
    })
    const fresh = area({ id: "new-900" })
    const { result } = setup([])
    await act(async () => {
      result.current.ed.setShapes([fresh])
      result.current.ed.setDirtyIds(new Set(["new-900"]))
    })
    await act(async () => result.current.s.wallsAroundAreas(["new-900"]))
    await await act(async () => result.current.edits.save.mutateAsync())
    const body = JSON.parse(
      String(apiMock.mock.calls[0][1]?.body)
    ) as FloorPlanBulkPayload
    expect(body.areas?.create?.[0].key).toBe("new-900")
    expect(body.walls?.create?.[0]).toMatchObject({
      label: "Cage walls",
      source_area_id: "new-900",
    })
  })
})

describe("the link card and the delete question", () => {
  it("the card's switch says Link to <name>, on", () => {
    const onLinked = vi.fn()
    render(
      <WallLinkCard
        name="Cage"
        count={1}
        linked
        onLinked={onLinked}
        onDismiss={() => {}}
      />
    )
    const sw = screen.getByRole("switch", { name: "Link to Cage" })
    expect(sw.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(sw)
    expect(onLinked).toHaveBeenCalledWith(false)
  })

  it("deleting an area with linked walls asks, walls too by default", () => {
    const onDelete = vi.fn()
    render(
      <AreaWallsDeleteDialog
        name="Cage"
        count={2}
        open
        onOpenChange={() => {}}
        onDelete={onDelete}
      />
    )
    expect(screen.getByText("It has 2 linked walls.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledWith("delete")
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenLastCalledWith("keep")
  })
})

describe("delete on the toolbar and on each row", () => {
  const wall = structureOf(
    [
      {
        id: "w1",
        label: "North",
        points: [
          [0, 0],
          [4, 0],
        ],
        height_mm: null,
        color: "",
        openings: [{ seg: 0, from: 1, to: 2, height_mm: null }],
        created_at: "",
        updated_at: "",
      },
    ],
    [],
    [
      {
        id: "r1",
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        plenum_mm: 300,
        label: "",
        color: "",
        created_at: "",
        updated_at: "",
      },
    ]
  )

  const bar = (row: StructShape, door: number | null, onDelete = vi.fn()) => {
    const onDeleteDoor = vi.fn()
    render(
      <TooltipProvider>
        <StructureToolbar
          row={row}
          door={door}
          picked={[]}
          doorArmed={false}
          onArmDoor={() => {}}
          onFlipDoor={() => {}}
          onDeleteDoor={onDeleteDoor}
          onJoin={() => {}}
          onDelete={onDelete}
        />
      </TooltipProvider>
    )
    return { onDelete, onDeleteDoor }
  }

  it("a wall's toolbar deletes the wall", () => {
    const { onDelete } = bar(wall[0], null)
    fireEvent.click(screen.getByRole("button", { name: "Delete wall" }))
    expect(onDelete).toHaveBeenCalledWith("w1")
  })

  it("a door's toolbar deletes the door", () => {
    const { onDeleteDoor } = bar(wall[0], 0)
    fireEvent.click(screen.getByRole("button", { name: "Delete door" }))
    expect(onDeleteDoor).toHaveBeenCalledWith(0)
  })

  it("a raised floor's toolbar deletes it", () => {
    const { onDelete } = bar(wall[1], null)
    fireEvent.click(screen.getByRole("button", { name: "Delete raised floor" }))
    expect(onDelete).toHaveBeenCalledWith("r1")
  })

  it("each wall and raised-floor row has a Delete", () => {
    const onDeleteArea = vi.fn()
    const onDeleteWall = vi.fn()
    render(
      <TooltipProvider>
        <StructureRail
          areas={[wall[1] as Extract<StructShape, { part: "raised_floor" }>]}
          selectedAreaId={null}
          drawing={false}
          onSelectArea={() => {}}
          onStartDraw={() => {}}
          onCancelDraw={() => {}}
          walls={[wall[0] as WallRow]}
          selectedWallId={null}
          wallDrawing={false}
          onSelectWall={() => {}}
          onStartWallDraw={() => {}}
          onCancelWallDraw={() => {}}
          onDeleteArea={onDeleteArea}
          onDeleteWall={onDeleteWall}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete North" }))
    expect(onDeleteWall).toHaveBeenCalledWith("w1")
    fireEvent.click(screen.getByRole("button", { name: "Delete raised floor" }))
    expect(onDeleteArea).toHaveBeenCalledWith("r1")
  })

  it("each tray row has a Delete", () => {
    const onDeleteTray = vi.fn()
    render(
      <TooltipProvider>
        <TrayRail
          trays={[
            {
              id: "t1",
              name: "Ladder A",
              kind: "",
              color: "",
              points: [
                [0, 0],
                [2, 0],
              ],
              level: "overhead",
              elevation_mm: null,
              capacity: null,
              description: "",
              cables: [],
              hidden_cable_count: 0,
              created_at: "",
              updated_at: "",
            },
          ]}
          selectedTrayId={null}
          drawing={false}
          editMode={false}
          onToggleEdit={() => {}}
          onSelectTray={() => {}}
          onStartDraw={() => {}}
          onCancelDraw={() => {}}
          onDeleteTray={onDeleteTray}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete Ladder A" }))
    expect(onDeleteTray).toHaveBeenCalledWith("t1")
  })
})
