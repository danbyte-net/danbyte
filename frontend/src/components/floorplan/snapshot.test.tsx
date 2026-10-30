// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  FloorPlan,
  FloorPlanFloor,
  FloorPlanPlaceable,
  FloorPlanStack,
  FloorPlanTile,
} from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { stackViewOf } from "@/components/columns/floor-plan-stack-columns"

import { FloorCanvas } from "./floor-canvas"
import { placedLabel } from "./place-picker"
import { PlanHeader } from "./plan-header"
import {
  edgeIds,
  isLiveView,
  snapshotLabel,
  viaQuery,
  viewBackgroundFrame,
} from "./snapshot"
import { SnapshotDialog } from "./snapshot-dialogs"
import { TOOLS, ToolRail, toolForKey } from "./tool-rail"
import { TOOL_MODE } from "./use-plan-edit-state"

// Snapshots: the Snapshot tool and its dialog (copy or live view, a floor
// plan of its own or a floor of this one), a live view's header and Unlink,
// and its edge objects drawn but locked.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

beforeEach(() => apiMock.mockReset())
afterEach(cleanup)

function plan(patch: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: "p1",
    numid: null,
    name: "Ground",
    location: { id: "l1", name: "Building A", slug: "building-a" },
    site: { id: "site1", name: "HQ" },
    stack: { id: "s1", name: "HQ Building" },
    floor_order: 0,
    elevation_mm: null,
    grid_width: 24,
    grid_height: 16,
    cell_mm: 600,
    ceiling_mm: 3000,
    background_image: null,
    background_opacity: 60,
    state: {},
    layout_mode: "grid",
    description: "",
    tile_count: 0,
    drawing: null,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    ...patch,
  }
}

const VIEW = plan({
  id: "v1",
  name: "Room 210",
  kind: "view",
  stack: { id: "s2", name: "Room 210" },
  snapshot: {
    kind: "view",
    source: { id: "p1", name: "Floor 2", stack: "HQ" },
    crop: { x: 4, y: 2, w: 6, h: 5 },
    at: "2026-10-30T10:00:00Z",
    source_grid: { width: 24, height: 16 },
  },
})

describe("the Snapshot tool", () => {
  it("is on the rail with S, and drags in Layout", () => {
    expect(TOOLS.some((t) => t.tool === "snapshot" && t.key === "s")).toBe(true)
    expect(toolForKey("s", false)).toBe("snapshot")
    expect(TOOL_MODE.snapshot).toBe("layout")
    const onToolChange = vi.fn()
    render(
      <TooltipProvider>
        <ToolRail
          tool="select"
          onToolChange={onToolChange}
          free={false}
          onToggleFree={() => {}}
          canToggleFree={false}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Snapshot" }))
    expect(onToolChange).toHaveBeenCalledWith("snapshot")
    // A view's layout is its source's: no free-placement switch.
    expect(screen.queryByRole("button", { name: "Free placement" })).toBeNull()
  })

  it("reports the dragged rectangle in whole cells", () => {
    const onSnapshotRect = vi.fn()
    const { container } = render(
      <FloorCanvas
        plan={plan({ grid_width: 12, grid_height: 8 })}
        tiles={[]}
        selectedId={null}
        editable
        showGrid
        armed={null}
        onSnapshotRect={onSnapshotRect}
      />
    )
    const svg = container.querySelector("svg")!
    // jsdom lays nothing out: the plan sits at zoom 1, 40 px in, 40 px to a
    // cell.
    Element.prototype.setPointerCapture = () => {}
    const point = (x: number, y: number) => ({
      clientX: x + 40,
      clientY: y + 40,
      button: 0,
      pointerId: 1,
    })
    fireEvent.pointerDown(svg, point(85, 45))
    fireEvent.pointerMove(svg, point(205, 165))
    fireEvent.pointerUp(svg, point(205, 165))
    expect(onSnapshotRect).toHaveBeenCalledWith({ x: 2, y: 1, w: 4, h: 4 })
  })
})

describe("the snapshot dialog", () => {
  it("sends the name, the crop, the kind and where it goes", async () => {
    apiMock.mockResolvedValue({ ...VIEW, crossing: [] })
    const onCreated = vi.fn()
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <SnapshotDialog
          plan={plan()}
          crop={{ x: 4, y: 2, w: 6, h: 5 }}
          onOpenChange={() => {}}
          onCreated={onCreated}
        />
      </QueryClientProvider>
    )
    expect(screen.getByText("Snapshot of HQ Building · Ground")).toBeTruthy()
    expect(screen.getByText("6×5 cells")).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText("Room 210"), {
      target: { value: "Room 210" },
    })
    fireEvent.click(
      screen.getByRole("radio", { name: "New floor of HQ Building" })
    )
    fireEvent.click(
      screen.getByRole("radio", { name: "Keep in sync (live view)" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Create snapshot" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/floor-plans/p1/snapshot/")
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Room 210",
      crop: { x: 4, y: 2, w: 6, h: 5 },
      mode: "view",
      target: "floor",
    })
  })

  it("makes an independent copy as a floor plan of its own by default", async () => {
    apiMock.mockResolvedValue({ ...plan({ id: "c1" }), crossing: [] })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SnapshotDialog
          plan={plan()}
          crop={{ x: 0, y: 0, w: 2, h: 2 }}
          onOpenChange={() => {}}
          onCreated={() => {}}
        />
      </QueryClientProvider>
    )
    fireEvent.change(screen.getByPlaceholderText("Room 210"), {
      target: { value: "Cage" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create snapshot" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body))).toMatchObject({
      mode: "copy",
      target: "plan",
    })
  })
})

function mountHeader(p: FloorPlan) {
  const floors: FloorPlanFloor[] = [
    {
      id: p.id,
      numid: null,
      name: p.name,
      floor_order: 0,
      location_id: "l1",
      kind: p.kind,
      view_of: p.kind === "view" ? { id: "p1", name: "Floor 2" } : null,
    },
  ]
  const stack: FloorPlanStack = {
    id: "s2",
    name: "Room 210",
    description: "",
    location: { id: "l1", name: "Building A", slug: "building-a" },
    site: { id: "site1", name: "HQ" },
    floors,
    floor_count: 1,
    last_edited: null,
    tags: [],
    created_at: "",
    updated_at: "",
  }
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/$id",
    component: () => (
      <PlanHeader
        plan={p}
        stack={stack}
        isDirty={false}
        canEdit
        canAdd
        view3d={false}
      />
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [`/floorplans/${p.id}`] }),
  })
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return stack
}

describe("a live view", () => {
  it("says what it is a view of, linking to it, and unlinks", async () => {
    apiMock.mockImplementation(async (path: string) =>
      path === "/api/me/"
        ? { is_authenticated: true, perms: [], permissions: {} }
        : { ...VIEW, kind: "plan", crossing: [] }
    )
    mountHeader(VIEW)
    const chip = await screen.findByText("View of HQ · Floor 2")
    expect(chip.closest("a")?.getAttribute("href")).toBe("/floorplans/p1")
    fireEvent.pointerDown(screen.getByRole("button", { name: /Room 210/ }), {
      button: 0,
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unlink…" }))
    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }))
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) => p === "/api/floor-plans/v1/unlink/")
      ).toBe(true)
    )
  })

  it("is a plain floor plan in the header when it is not a snapshot", async () => {
    mountHeader(plan())
    await screen.findByRole("button", { name: /Room 210/ })
    expect(screen.queryByText(/View of|Copy of/)).toBeNull()
  })

  it("draws the rows crossing its edge faded and locked while editing", () => {
    const tile = (id: string, x: number): FloorPlanTile =>
      ({
        id,
        x,
        y: 1,
        width: 1,
        height: 1,
        orientation: 0,
        tile_type: null,
        role_type: null,
        label: id,
        color: "",
        status: "",
        link_kind: "",
        linked: null,
        fov_deg: null,
        fov_distance: null,
        fov_direction: null,
        fov_anchor: "",
        fov_ptz: false,
        created_at: "",
        updated_at: "",
      }) as unknown as FloorPlanTile
    const onSelect = vi.fn()
    const { container } = render(
      <FloorCanvas
        plan={VIEW}
        tiles={[tile("in", 1), tile("edge", 5)]}
        selectedId={null}
        editable
        showGrid
        armed={null}
        onSelect={onSelect}
        lockedIds={new Set(["edge"])}
        clipToGrid
      />
    )
    const groups = Array.from(
      container.querySelectorAll<SVGGElement>('g[role="img"]')
    ).map((g) => g.parentElement as unknown as SVGGElement)
    const [inside, edge] = groups
    expect(edge.getAttribute("pointer-events")).toBe("none")
    expect(edge.getAttribute("opacity")).toBe("0.5")
    expect(inside.getAttribute("pointer-events")).toBeNull()
    expect(container.querySelector("clipPath#fp-grid-clip-v1")).toBeTruthy()
  })
})

describe("snapshot helpers", () => {
  it("tell a view, its write query and its background frame", () => {
    expect(isLiveView(VIEW)).toBe(true)
    expect(isLiveView(plan())).toBe(false)
    expect(viaQuery(VIEW)).toBe("?via=v1")
    expect(viaQuery(plan())).toBe("")
    expect(viewBackgroundFrame(VIEW)).toEqual({
      x: -4,
      y: -2,
      width: 24,
      height: 16,
    })
    expect(viewBackgroundFrame(plan())).toBeNull()
  })

  it("collects the edge rows of a view's contents", () => {
    const ids = edgeIds({
      tiles: [
        { id: "a", crosses_edge: true },
        { id: "b", crosses_edge: false },
      ] as unknown as FloorPlanTile[],
      walls: [{ id: "w", crosses_edge: true }] as never,
    })
    expect([...ids].sort()).toEqual(["a", "w"])
  })

  it("names a copy's source and date", () => {
    const copy = plan({
      snapshot: {
        kind: "copy",
        source: { id: "p1", name: "Floor 2", stack: "HQ" },
        crop: { x: 0, y: 0, w: 1, h: 1 },
        at: "2026-10-30T10:00:00Z",
      },
    })
    expect(snapshotLabel(copy, () => "30 Oct 2026")).toBe(
      "Copy of HQ · Floor 2 · 30 Oct 2026"
    )
    expect(snapshotLabel(plan())).toBeNull()
  })

  it("marks a list row whose floors are all views", () => {
    const row = {
      floors: [{ kind: "view", view_of: { id: "p1", name: "Floor 2" } }],
    } as unknown as FloorPlanStack
    expect(stackViewOf(row)).toBe("View of Floor 2")
    expect(
      stackViewOf({ floors: [{ kind: "plan" }] } as unknown as FloorPlanStack)
    ).toBeNull()
  })

  it("counts the other plans an object stands on", () => {
    const row = (on: [string, boolean][]) =>
      ({
        placed_count: on.length,
        placed_on: on.map(([name, here]) => ({
          floor_plan: { id: name, name, stack: "" },
          tile_id: name,
          this_floor: here,
        })),
      }) as unknown as FloorPlanPlaceable
    expect(
      placedLabel(
        row([
          ["Ground", true],
          ["Room 210", false],
        ])
      )
    ).toBe("On this floor +1")
    expect(
      placedLabel(
        row([
          ["A", false],
          ["B", false],
        ])
      )
    ).toBe("A +1")
    expect(placedLabel(row([]))).toBeNull()
  })
})
