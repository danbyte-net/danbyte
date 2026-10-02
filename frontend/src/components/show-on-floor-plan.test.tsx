// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanTile } from "@/lib/api"
import { ShowOnFloorPlan } from "./show-on-floor-plan"

// "Show on floor plan" in a rack's, a cabinet's or a device's header: the
// plan the object stands on, zoomed onto its tile - a device by way of its
// rack's or cabinet's tile when it has none of its own.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))

const placed = (id: string, planId: string, plan: string): FloorPlanTile =>
  ({
    id,
    floor_plan: { id: planId, name: plan, grid_width: 12, grid_height: 8 },
  }) as FloorPlanTile

let tiles: Record<string, FloorPlanTile[]> = {}
beforeEach(() => {
  tiles = {}
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const query = path.split("?")[1] ?? ""
    return Promise.resolve({
      count: (tiles[query] ?? []).length,
      results: tiles[query] ?? [],
    })
  })
})
afterEach(cleanup)

function mount(props: Parameters<typeof ShowOnFloorPlan>[0]) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/cabinets/$id",
    component: () => <ShowOnFloorPlan {...props} />,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/cabinets/c1"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

const hrefOf = (el: HTMLElement) => {
  const u = new URL(el.getAttribute("href") ?? "", "http://x")
  return `${u.pathname}?${u.searchParams.toString()}`
}

describe("ShowOnFloorPlan on a cabinet's page", () => {
  it("opens the plan zoomed onto the cabinet's tile", async () => {
    tiles["cabinet=c1"] = [placed("t1", "p1", "Serverrum A")]
    mount({ cabinetId: "c1" })
    const link = await screen.findByRole("link", {
      name: "Show on floor plan",
    })
    expect(hrefOf(link)).toBe("/floorplans/p1?tile=t1")
    expect(apiMock).toHaveBeenCalledWith("/api/floor-plan-tiles/?cabinet=c1")
  })

  it("lists every plan the cabinet stands on", async () => {
    tiles["cabinet=c1"] = [
      placed("t1", "p1", "Floor 1"),
      placed("t2", "p2", "What-if"),
    ]
    mount({ cabinetId: "c1" })
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /Show on floor plan/ }),
      { button: 0, ctrlKey: false }
    )
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["Floor 1", "What-if"])
  })

  it("is not there while the cabinet is on no plan", async () => {
    mount({ cabinetId: "c1" })
    await vi.waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/floor-plan-tiles/?cabinet=c1")
    )
    expect(screen.queryByText(/floor plan/)).toBeNull()
  })
})

describe("ShowOnFloorPlan by way of a container", () => {
  it("reaches a device through its cabinet's tile", async () => {
    tiles["cabinet=c1"] = [placed("t1", "p1", "Serverrum A")]
    mount({ deviceId: "d1", cabinetId: "c1" })
    const link = await screen.findByRole("link", {
      name: "On floor plan (via cabinet)",
    })
    expect(hrefOf(link)).toBe("/floorplans/p1?tile=t1")
  })

  it("says nothing of a rack on the rack's own page", async () => {
    tiles["rack=r1"] = [placed("t9", "p9", "Hall")]
    mount({ rackId: "r1" })
    expect(
      await screen.findByRole("link", { name: "Show on floor plan" })
    ).toBeTruthy()
  })
})
