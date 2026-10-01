// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { NamedDashboard } from "@/lib/api"
import { NamedBoard } from "./named-board"

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: toastMock }))
// The grid and the settings dialog are not what this is about.
vi.mock("./board", () => ({
  AddWidgetMenu: () => null,
  DashboardGrid: () => null,
  StatBand: () => null,
  metaForItem: () => ({ min: { w: 1, h: 1 }, max: { w: 12, h: 12 } }),
  withWidget: (items: unknown[]) => items,
}))
vi.mock("./dashboard-settings", () => ({
  DashboardSettingsDialog: () => null,
  scopeQuery: () => "",
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const ID = "0b8f1c1e-3c55-4a43-9d0e-5f7a7e1c2d10"
const BOARD: NamedDashboard = {
  id: ID,
  name: "NOC",
  description: "",
  owner_name: "alice",
  mine: true,
  visibility: "private",
  groups: [],
  layout: { v: 2, items: [] },
  scope: {},
  frame: "7d",
  refresh_seconds: 0,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}

/** The board is the user's home pick until it is deleted. */
let deleted = false
const notFound = () =>
  Object.assign(new Error("No Dashboard matches the given query."), {
    status: 404,
  })
const gets = (path: string) =>
  apiMock.mock.calls.filter(([p, init]) => p === path && !init?.method).length

beforeEach(() => {
  deleted = false
  apiMock.mockReset()
  apiMock.mockImplementation(async (path, init) => {
    if (init?.method === "DELETE") {
      deleted = true
      return undefined
    }
    if (path === "/api/dashboards/home/") return { id: deleted ? null : ID }
    if (path === `/api/dashboards/${ID}/`) {
      if (deleted) throw notFound()
      return BOARD
    }
    if (path.startsWith("/api/dashboards/?"))
      return { count: 1, next: null, previous: null, results: [BOARD] }
    // The widgets' data: not needed here.
    return new Promise(() => {})
  })
})
afterEach(cleanup)

function renderBoard() {
  const root = createRootRoute()
  const routeTree = root.addChildren([
    createRoute({
      getParentRoute: () => root,
      path: "/dashboards/$id",
      component: () => <NamedBoard id={ID} />,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/dashboards",
      component: () => <p>All dashboards</p>,
    }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/dashboards/${ID}`] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return qc
}

describe("NamedBoard", () => {
  it("forgets a deleted board and the home pick that opened it (#269)", async () => {
    const qc = renderBoard()
    fireEvent.keyDown(await screen.findByRole("button", { name: "More" }), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))

    await screen.findByText("All dashboards")
    // "/" reads the pick again, so the Dashboard link opens the own layout.
    await waitFor(() =>
      expect(qc.getQueryData(["dashboard-home"])).toEqual({ id: null })
    )
    // Back on its page, nothing shows the deleted board from the cache.
    expect(qc.getQueryData(["named-dashboard", ID])).toBeUndefined()
    expect(gets("/api/dashboards/home/")).toBe(2)
  })
})
