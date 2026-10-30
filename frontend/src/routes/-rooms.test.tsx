// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
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

import type { Room } from "@/lib/api"
import { Route as ListRoute } from "./rooms.index"
import { Route as DetailRoute } from "./rooms.$id"

// The Rooms list (one column factory, the shared bulk edit and safe bulk
// delete) and a room's page: Overview first, then what stands in the room,
// Journal and Change log last.

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
vi.mock("@/components/detail-shell", () => ({
  DetailShell: ({
    hero,
    tabs,
    children,
  }: {
    hero: ReactNode
    tabs: { value: string; label: string; count?: number }[]
    children: ReactNode
  }) => (
    <div>
      {hero}
      <nav>
        {tabs.map((t) => (
          <span key={t.value} data-testid="tab">
            {t.label}
          </span>
        ))}
      </nav>
      {children}
    </div>
  ),
  DetailHero: ({ title, badges }: { title: ReactNode; badges: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {badges}
    </header>
  ),
  DetailTab: ({ value, children }: { value: string; children: ReactNode }) =>
    value === "overview" ? <section>{children}</section> : null,
}))
vi.mock("@/components/object-images", () => ({ ObjectImages: () => null }))
vi.mock("@/components/custom-field-display", () => ({
  CustomFieldValues: () => null,
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

function room(id: string, name: string, patch: Partial<Room> = {}): Room {
  return {
    id,
    numid: null,
    name,
    slug: name.toLowerCase(),
    code: "",
    location: { id: "l1", name: "Floor 2", color: "", icon: "" },
    site: { id: "s1", name: "HQ" },
    status: null,
    color: "",
    description: "",
    device_count: 0,
    rack_count: 0,
    cabinet_count: 0,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    ...patch,
  }
}

const ROOMS = [
  room("rm1", "Comms 210", { code: "210", color: "#2563eb", device_count: 3 }),
  room("rm2", "Store"),
]

beforeAll(async () => {
  for (const r of [ListRoute, DetailRoute]) {
    const lazy = r.options.component as { preload?: () => Promise<void> }
    await lazy.preload?.()
  }
})
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.endsWith("bulk-edit-fields/"))
      return Promise.resolve({
        tags: true,
        custom_fields: "room",
        fields: [
          { key: "color", label: "Color", kind: "color", nullable: false },
        ],
      })
    if (path === "/api/rooms/rm1/") return Promise.resolve(ROOMS[0])
    if (path.startsWith("/api/rooms/"))
      return Promise.resolve({ count: 2, results: ROOMS, next: null })
    return Promise.resolve({ count: 0, results: [], next: null })
  })
})
afterEach(cleanup)

function mount(url: string) {
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/rooms",
    component: ListRoute.options.component,
  })
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/rooms/$id",
    component: DetailRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([list, detail]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

describe("the Rooms list", () => {
  it("draws each room as its badge and opens the server's bulk edit", async () => {
    mount("/rooms")
    const pill = await screen.findByText("Comms 210")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(screen.getByText("210")).toBeTruthy()
    for (const box of screen.getAllByRole("checkbox", { name: "Select row" }))
      fireEvent.click(box)
    const clear = await screen.findByRole("button", {
      name: "Clear selection",
    })
    fireEvent.click(
      within(clear.parentElement!).getByRole("button", { name: /Edit/ })
    )
    expect(await screen.findByText("Edit 2 rooms")).toBeTruthy()
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) => p === "/api/rooms/bulk-edit-fields/")
      ).toBe(true)
    )
  })
})

describe("a room's page", () => {
  it("puts Overview first and Journal and Change log last", async () => {
    mount("/rooms/rm1")
    await screen.findByRole("heading", { name: "Comms 210" })
    expect(screen.getAllByTestId("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Devices",
      "Racks",
      "Cabinets",
      "Journal",
      "Change log",
    ])
  })

  it("has a Floor plan tab only while the room is drawn on a floor", async () => {
    const plan = { areas: [] as unknown[], area: null }
    const base = apiMock.getMockImplementation()!
    apiMock.mockImplementation((path, init) =>
      path === "/api/rooms/rm1/plan/" ? Promise.resolve(plan) : base(path, init)
    )
    mount("/rooms/rm1")
    await screen.findByRole("heading", { name: "Comms 210" })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/rooms/rm1/plan/")
    )
    expect(screen.queryByText("Floor plan")).toBeNull()
    cleanup()
    plan.areas = [
      {
        id: "a1",
        name: "Comms 210",
        color: "#2563eb",
        floor_plan: { id: "p1", name: "Ground", stack: null },
      },
    ]
    mount("/rooms/rm1")
    await screen.findByRole("heading", { name: "Comms 210" })
    await waitFor(() =>
      expect(screen.getAllByTestId("tab").map((t) => t.textContent)).toEqual([
        "Overview",
        "Devices",
        "Racks",
        "Cabinets",
        "Floor plan",
        "Journal",
        "Change log",
      ])
    )
  })

  it("shows where the room is in its Overview", async () => {
    mount("/rooms/rm1")
    await screen.findByRole("heading", { name: "Comms 210" })
    expect(
      screen.getByRole("link", { name: "Floor 2" }).getAttribute("href")
    ).toBe("/locations/l1")
    expect(screen.getByRole("link", { name: "HQ" }).getAttribute("href")).toBe(
      "/sites/s1"
    )
  })
})
