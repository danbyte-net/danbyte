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

import type { FloorPlan, FloorPlanFloor, FloorPlanStack } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PlanHeader } from "./plan-header"

// The editor header: the floor plan's name, its floors in order, and "+ Add
// floor". The URL is the floor - switching floors changes it and keeps 2D/3D.

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

const floor = (id: string, name: string, order: number): FloorPlanFloor => ({
  id,
  numid: null,
  name,
  floor_order: order,
  location_id: "l1",
})

function stackOf(floors: FloorPlanFloor[]): FloorPlanStack {
  return {
    id: "s1",
    name: "HQ Building",
    description: "",
    location: { id: "l1", name: "Building A", slug: "building-a" },
    site: { id: "site1", name: "HQ" },
    floors,
    floor_count: floors.length,
    last_edited: null,
    tags: [],
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
  }
}

function plan(id: string, name: string): FloorPlan {
  return {
    id,
    numid: null,
    name,
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
    description: "",
    tile_count: 0,
    drawing: null,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
  }
}

const THREE = [
  floor("f0", "B1", -10),
  floor("f1", "Ground", 0),
  floor("f2", "1", 10),
]

function mount(url: string, floors: FloorPlanFloor[] = THREE) {
  const stack = stackOf(floors)
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/$id",
    validateSearch: (s: Record<string, unknown>) =>
      s.viz === "3d" ? { viz: "3d" as const } : {},
    component: function Page() {
      const { id } = page.useParams()
      const { viz } = page.useSearch()
      const f = floors.find((x) => x.id === id)
      return (
        <PlanHeader
          plan={plan(id, f?.name ?? id)}
          stack={stack}
          isDirty={false}
          canEdit
          canAdd
          view3d={viz === "3d"}
          mode="layout"
          onModeChange={() => {}}
        />
      )
    },
  })
  const list = createRoute({
    getParentRoute: () => root,
    path: "/floorplans",
    component: () => null,
  })
  const router = createRouter({
    routeTree: root.addChildren([page, list]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return router
}

beforeEach(() => apiMock.mockReset())
afterEach(cleanup)

describe("the floor switcher", () => {
  it("lists the floors in order and keeps the floor and the 3D view in the URL", async () => {
    const router = mount("/floorplans/f1?viz=3d")
    await screen.findByRole("heading", { name: "HQ Building" })
    const tabs = screen
      .getAllByRole("button")
      .filter((b) => ["B1", "Ground", "1"].includes(b.textContent))
    expect(tabs.map((t) => t.textContent)).toEqual(["B1", "Ground", "1"])
    expect(
      screen
        .getByRole("button", { name: "Ground" })
        .getAttribute("aria-current")
    ).toBe("page")
    fireEvent.click(screen.getByRole("button", { name: "B1" }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/floorplans/f0")
    )
    expect(router.state.location.search).toEqual({ viz: "3d" })
    expect(
      screen.getByRole("button", { name: "B1" }).getAttribute("aria-current")
    ).toBe("page")
  })

  it("becomes a dropdown past six floors", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      floor(`f${i}`, `${i}`, i * 10)
    )
    mount("/floorplans/f3", many)
    expect(await screen.findByRole("button", { name: "Floor" })).toHaveProperty(
      "textContent",
      "Floor: 3"
    )
  })

  it("adds a floor with a name and opens it", async () => {
    apiMock.mockResolvedValue(plan("f9", "Roof"))
    const router = mount("/floorplans/f1")
    fireEvent.click(await screen.findByRole("button", { name: "Add floor" }))
    fireEvent.change(await screen.findByPlaceholderText("2, Ground, B1…"), {
      target: { value: "Roof" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add floor" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/floor-plan-stacks/s1/floors/")
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Roof",
      copy_from: "f1",
    })
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/floorplans/f9")
    )
  })
})
