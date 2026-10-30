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

import type { FloorPlan, FloorPlanArea, FloorPlanRegion } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { AreaMask } from "./area-mask"
import { AreaPlanTab } from "./area-plan-tab"
import { SelectionToolbar } from "./placement-panels"
import { areaCrop, snapshotAreaLabel, viewMask } from "./snapshot"
import { SnapshotDialog } from "./snapshot-dialogs"

// Snapshots of a room, location or area (the dialog's area choice, the
// area's toolbar, a view's mask) and a room's Floor plan tab.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
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
    grid_width: 20,
    grid_height: 10,
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

function area(patch: Partial<FloorPlanArea> = {}): FloorPlanArea {
  return {
    id: "a1",
    shape: "rect",
    x: 4.5,
    y: 2,
    width: 4,
    height: 3,
    rotation: 0,
    points: [],
    room: { id: "r1", name: "R210", code: "", color: "#2563eb" },
    location: null,
    label: "",
    color: "",
    fill_opacity: 15,
    border: "solid",
    show_name: true,
    z: 0,
    locked: false,
    created_at: "",
    updated_at: "",
    ...patch,
  }
}

function withClient(node: React.ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  )
}

describe("an area's crop", () => {
  it("takes the whole cells of its box, a margin more, inside the grid", () => {
    const box = { minX: 4.5, minY: 2, maxX: 8.5, maxY: 5 }
    expect(areaCrop(box, 0, 20, 10)).toEqual({ x: 4, y: 2, w: 5, h: 3 })
    expect(areaCrop(box, 1, 20, 10)).toEqual({ x: 3, y: 1, w: 7, h: 5 })
    expect(areaCrop(box, 9, 20, 10)).toEqual({ x: 0, y: 0, w: 18, h: 10 })
  })

  it("names what is snapshotted", () => {
    expect(snapshotAreaLabel(area())).toBe("Snapshot this room…")
    expect(
      snapshotAreaLabel(
        area({ room: null, location: { id: "l", name: "L", color: "" } })
      )
    ).toBe("Snapshot this location…")
    expect(snapshotAreaLabel(area({ room: null }))).toBe("Snapshot this area…")
  })

  it("masks a view made from an area, and only that", () => {
    const mask: [number, number][] = [
      [0, 0],
      [2, 0],
      [0, 2],
    ]
    const snapshot = {
      kind: "view" as const,
      source: null,
      crop: { x: 0, y: 0, w: 2, h: 2 },
      at: null,
      mask,
    }
    expect(viewMask({ kind: "view", snapshot })).toEqual(mask)
    expect(viewMask({ kind: "plan", snapshot })).toBeNull()
    expect(
      viewMask({ kind: "view", snapshot: { ...snapshot, mask: null } })
    ).toBeNull()
    const { container } = render(
      <svg>
        <AreaMask outline={mask} width={2} height={2} />
      </svg>
    )
    const path = container.querySelector('[data-part="area-mask"]')!
    expect(path.getAttribute("fill-rule")).toBe("evenodd")
    expect(path.getAttribute("d")).toBe("M0 0H80V80H0ZM0 0L80 0L0 80Z")
  })
})

describe("the snapshot dialog, of an area", () => {
  it("starts from the area, named after it, and sends it with the margin", async () => {
    apiMock.mockResolvedValue({ ...plan({ id: "v1" }), crossing: [] })
    const onCreated = vi.fn()
    render(
      withClient(
        <SnapshotDialog
          plan={plan()}
          areaId="a1"
          areas={[area()]}
          onOpenChange={() => {}}
          onCreated={onCreated}
        />
      )
    )
    expect(
      screen.getByPlaceholderText<HTMLInputElement>("Room 210").value
    ).toBe("R210")
    expect(screen.getByText("5×3 cells")).toBeTruthy()
    // No rectangle was dragged: nothing to choose between.
    expect(screen.queryByText("The drawn rectangle")).toBeNull()
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "1" },
    })
    expect(screen.getByText("7×5 cells")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("radio", { name: "Keep in sync (live view)" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Create snapshot" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body))).toEqual({
      name: "R210",
      area_id: "a1",
      margin: 1,
      mode: "view",
      target: "plan",
    })
  })

  it("offers the floor's areas beside a dragged rectangle", async () => {
    apiMock.mockResolvedValue({ ...plan({ id: "c1" }), crossing: [] })
    render(
      withClient(
        <SnapshotDialog
          plan={plan()}
          crop={{ x: 0, y: 0, w: 2, h: 2 }}
          areas={[area()]}
          onOpenChange={() => {}}
          onCreated={() => {}}
        />
      )
    )
    expect(screen.getByText("2×2 cells")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("radio", { name: "A room, location or area" })
    )
    // The room's badge is the picked value, its name the snapshot's.
    expect(screen.getByRole("combobox").textContent).toContain("R210")
    expect(
      screen.getByPlaceholderText<HTMLInputElement>("Room 210").value
    ).toBe("R210")
    fireEvent.click(screen.getByRole("button", { name: "Create snapshot" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body))).toMatchObject({
      area_id: "a1",
      margin: 0,
    })
  })

  it("is offered on a selected area's toolbar", () => {
    const onSnapshotShape = vi.fn()
    render(
      withClient(
        <SelectionToolbar
          plan={plan()}
          tile={null}
          shape={{ ...area(), kind: "area" }}
          shapes={[]}
          onTileDisplay={() => {}}
          onRestackTile={() => {}}
          onDeleteTile={() => {}}
          onSetRoom={() => {}}
          onChangeShape={() => {}}
          onRestackShape={() => {}}
          onDeleteShape={() => {}}
          onSnapshotShape={onSnapshotShape}
        />
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Snapshot this room…" }))
    expect(onSnapshotShape).toHaveBeenCalledWith("a1")
  })
})

function region(patch: Partial<FloorPlanRegion> = {}): FloorPlanRegion {
  return {
    areas: [
      {
        id: "a1",
        name: "R210",
        color: "#2563eb",
        floor_plan: {
          id: "p1",
          name: "Ground",
          stack: { id: "s1", name: "HQ Building" },
        },
      },
    ],
    area: "a1",
    floor_plan: plan(),
    crop: { x: 4, y: 2, w: 5, h: 3 },
    margin: 0,
    outline: [
      [0.5, 0],
      [4.5, 0],
      [4.5, 3],
      [0.5, 3],
    ],
    contents: {
      version: null,
      tiles: [],
      trays: [],
      walls: [],
      raised_floors: [],
      areas: [area({ x: 0.5, y: 0 })],
      labels: [],
    },
    ...patch,
  }
}

function mountTab(r: FloorPlanRegion) {
  apiMock.mockImplementation(async (path: string) =>
    String(path).includes("/plan/") ? r : { as_of: "", tiles: {} }
  )
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/rooms/$id",
    component: () => <AreaPlanTab owner="rooms" id="r1" />,
  })
  const floor = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/$id",
  })
  const router = createRouter({
    routeTree: root.addChildren([page, floor]),
    history: createMemoryHistory({ initialEntries: ["/rooms/r1"] }),
  })
  return render(withClient(<RouterProvider router={router as never} />))
}

describe("a room's Floor plan tab", () => {
  it("draws its part of the floor, dimmed outside it, and opens it there", async () => {
    const { container } = mountTab(region())
    const open = await screen.findByRole("link", {
      name: "Open in floor plan",
    })
    expect(open.getAttribute("href")).toBe("/floorplans/p1?area=a1")
    expect(apiMock).toHaveBeenCalledWith("/api/rooms/r1/plan/")
    expect(container.querySelector('[data-part="area-mask"]')).toBeTruthy()
    expect(screen.getByText("HQ Building · Ground")).toBeTruthy()
  })

  it("makes a snapshot of the room from its tab", async () => {
    mountTab(region())
    fireEvent.click(
      await screen.findByRole("button", { name: "Make snapshot…" })
    )
    expect(
      await screen.findByText("Snapshot of HQ Building · Ground")
    ).toBeTruthy()
    expect(
      screen.getByPlaceholderText<HTMLInputElement>("Room 210").value
    ).toBe("R210")
    // Measured on the floor: the area's own box.
    expect(screen.getByText("5×3 cells")).toBeTruthy()
  })

  it("switches between the floors the room is drawn on", async () => {
    const second = {
      id: "a2",
      name: "R210",
      color: "#2563eb",
      floor_plan: {
        id: "p2",
        name: "Upper",
        stack: { id: "s1", name: "HQ Building" },
      },
    }
    mountTab(region({ areas: [...region().areas, second] }))
    fireEvent.click(
      await screen.findByRole("button", { name: "HQ Building · Upper" })
    )
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/rooms/r1/plan/?area=a2")
    )
  })
})
