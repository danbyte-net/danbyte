// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { FloorPlanStack } from "@/lib/api"
import { rememberFloor } from "@/lib/floor-plan-stacks"
import { Route as ListRoute } from "./floorplans.index"
import { Route as StackRoute } from "./floorplans.stacks.$id"

// Maps → Floor plans lists floor plans (stacks) with their floor count; a
// floor plan opens its last-viewed floor in this browser, else its first.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

function stack(
  id: string,
  name: string,
  floors: string[],
  location: string | null = "Building A"
): FloorPlanStack {
  return {
    id,
    name,
    description: "",
    location: location ? { id: `l-${id}`, name: location, slug: id } : null,
    site: { id: "site1", name: "HQ" },
    floors: floors.map((f, i) => ({
      id: `${id}-${f}`,
      numid: null,
      name: f,
      floor_order: i * 10,
      location_id: `l-${id}`,
    })),
    floor_count: floors.length,
    last_edited: "2026-10-30T00:00:00Z",
    tags: [],
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
  }
}

const STACKS = [
  stack("hq", "HQ Building", ["B1", "Ground", "1"]),
  stack("dc", "DC Hall", ["Hall"], "Building B"),
  stack("campus", "Campus", ["Site"], null),
]

beforeAll(async () => {
  for (const r of [ListRoute, StackRoute]) {
    const lazy = r.options.component as { preload?: () => Promise<void> }
    await lazy.preload?.()
  }
})
beforeEach(() => {
  window.localStorage.clear()
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path === "/api/floor-plan-stacks/hq/") return Promise.resolve(STACKS[0])
    if (path === "/api/floor-plan-stacks/empty/")
      return Promise.resolve(stack("empty", "Annex", []))
    if (path.startsWith("/api/floor-plan-stacks/"))
      return Promise.resolve({ count: 2, results: STACKS, next: null })
    return Promise.resolve({ count: 0, results: [], next: null })
  })
})
afterEach(cleanup)

function mount(url: string) {
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/floorplans",
    component: ListRoute.options.component,
  })
  const stackRoute = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/stacks/$id",
    component: StackRoute.options.component,
  })
  const floorRoute = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/$id",
    component: () => <p>floor page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([list, stackRoute, floorRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return router
}

describe("the floor plans list", () => {
  it("shows floor plans with their floor count, opening the first or last-viewed floor", async () => {
    rememberFloor("hq", "hq-1")
    mount("/floorplans")
    const hq = await screen.findByRole("link", { name: "HQ Building" })
    expect(hq.getAttribute("href")).toBe("/floorplans/hq-1")
    expect(
      screen.getByRole("link", { name: "DC Hall" }).getAttribute("href")
    ).toBe("/floorplans/dc-Hall")
    const row = hq.closest("tr")!
    expect(row.textContent).toContain("3")
    expect(
      apiMock.mock.calls.some(([p]) => p.startsWith("/api/floor-plan-stacks/?"))
    ).toBe(true)
  })

  it("reads Whole site for a site-wide floor plan", async () => {
    mount("/floorplans")
    const campus = await screen.findByRole("link", { name: "Campus" })
    const row = campus.closest("tr")!
    expect(row.textContent).toContain("Whole site")
    expect(row.textContent).toContain("HQ")
  })

  it("forgets a remembered floor that left the floor plan", async () => {
    rememberFloor("hq", "gone")
    mount("/floorplans")
    const hq = await screen.findByRole("link", { name: "HQ Building" })
    expect(hq.getAttribute("href")).toBe("/floorplans/hq-B1")
  })
})

describe("a floor plan's own link", () => {
  it("opens its first floor", async () => {
    const router = mount("/floorplans/stacks/hq")
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/floorplans/hq-B1")
    )
  })

  it("offers Add floor when it has none", async () => {
    mount("/floorplans/stacks/empty")
    expect(await screen.findByText("No floors yet.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add floor" })).toBeTruthy()
  })
})
