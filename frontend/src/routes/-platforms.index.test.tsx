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

import type { Platform } from "@/lib/api"
import { Route } from "./platforms.index"

// The Platforms list's selection bar: ticked rows offer Edit (the fields the
// server names) and Delete (a dry run first, naming the platforms kept
// because something still runs them). Without the grants, no bar.

const { apiMock, can } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  can: { value: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: (_t: string, a: string) => a === "view" || can.value,
    humanIds: false,
  }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    rail,
    children,
  }: {
    rail?: ReactNode
    children: ReactNode
  }) => (
    <div>
      {rail}
      {children}
    </div>
  ),
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

function platform(id: string, name: string, used = 0): Platform {
  return {
    id,
    numid: null,
    name,
    slug: name.toLowerCase(),
    group: null,
    manufacturer: null,
    config_template: null,
    description: "",
    tags: [],
    device_count: used,
    vm_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as unknown as Platform
}

const PLATFORMS = [platform("p1", "IOS-XE", 2), platform("p2", "Spare")]

beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
beforeEach(() => {
  can.value = true
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.endsWith("bulk-delete/"))
      return Promise.resolve({
        deleted: 1,
        deleted_ids: ["p2"],
        skipped: [{ id: "p1", name: "IOS-XE", reason: "In use: 2 devices." }],
        impact: [],
        released: [],
        dry_run: true,
      })
    if (path.endsWith("bulk-edit-fields/"))
      return Promise.resolve({
        tags: true,
        fields: [
          {
            key: "description",
            label: "Description",
            kind: "text",
            nullable: false,
          },
        ],
      })
    if (path.startsWith("/api/platforms/"))
      return Promise.resolve({
        count: PLATFORMS.length,
        results: PLATFORMS,
        next: null,
      })
    return Promise.resolve({ count: 0, results: [], next: null })
  })
})
afterEach(cleanup)

function mount() {
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/platforms",
    component: Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/platforms"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

/** Tick every row; the selection bar that floats up. */
async function tickAll() {
  await screen.findByText("Spare")
  for (const box of screen.getAllByRole("checkbox", { name: "Select row" }))
    fireEvent.click(box)
  const clear = await screen.findByRole("button", { name: "Clear selection" })
  return within(clear.parentElement!)
}

describe("the Platforms list", () => {
  it("previews a bulk delete and names the platform kept", async () => {
    mount()
    const bar = await tickAll()
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("In use: 2 devices.")).toBeTruthy()
    const call = apiMock.mock.calls.find(([p]) => p.endsWith("bulk-delete/"))!
    expect(call[0]).toBe("/api/platforms/bulk-delete/")
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      ids: ["p1", "p2"],
      dry_run: true,
    })
  })

  it("opens the bulk edit with the server's fields", async () => {
    mount()
    const bar = await tickAll()
    fireEvent.click(bar.getByRole("button", { name: /Edit/ }))
    expect(await screen.findByText("Edit 2 platforms")).toBeTruthy()
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          ([p]) => p === "/api/platforms/bulk-edit-fields/"
        )
      ).toBe(true)
    )
  })

  it("offers no selection without change or delete", async () => {
    can.value = false
    mount()
    await screen.findByText("Spare")
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull()
  })
})
