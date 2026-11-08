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

import type { EolCustomProduct } from "@/lib/api"
import { Route } from "./eol-products.index"

// The custom end-of-life products list: the rail filters on use and cycles,
// ticked rows offer Export, Edit (the fields the server names) and Delete (a
// dry run first, naming the products kept because something names them).
// Without the grants, no selection.

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

function product(
  id: string,
  label: string,
  apps = 0,
  platforms = 0
): EolCustomProduct {
  return {
    id,
    source: "custom",
    name: label.toLowerCase(),
    label,
    link: "",
    notes: "",
    releases: [],
    cycle_count: 1,
    application_count: apps,
    platform_count: platforms,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }
}

const PRODUCTS = [product("e1", "Acme", 1), product("e2", "Spare")]

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
        deleted_ids: ["e2"],
        skipped: [
          {
            id: "e1",
            name: "Acme",
            reason:
              "In use by 1 application - map them to another product first.",
          },
        ],
        impact: [],
        released: [],
        dry_run: true,
      })
    if (path.endsWith("bulk-edit-fields/"))
      return Promise.resolve({
        tags: false,
        custom_fields: null,
        fields: [
          { key: "link", label: "Link", kind: "text", nullable: false },
          { key: "notes", label: "Notes", kind: "text", nullable: false },
        ],
      })
    if (path.startsWith("/api/eol/custom-products/"))
      return Promise.resolve({
        count: PRODUCTS.length,
        results: PRODUCTS,
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
    path: "/eol-products",
    component: Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/eol-products"] }),
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

describe("the End-of-life products list", () => {
  it("filters on use and cycles in the rail", async () => {
    mount()
    await screen.findByText("Spare")
    expect(screen.getAllByText("Applications").length).toBeGreaterThan(1)
    expect(screen.getAllByText("Platforms").length).toBeGreaterThan(1)
    expect(screen.getAllByText("Cycles").length).toBeGreaterThan(1)
    expect(screen.getAllByText("In use").length).toBeGreaterThan(0)
  })

  it("previews a bulk delete and names the product kept", async () => {
    mount()
    const bar = await tickAll()
    expect(bar.getByRole("button", { name: /Export/ })).toBeTruthy()
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(
      await screen.findByText(
        "In use by 1 application - map them to another product first."
      )
    ).toBeTruthy()
    const call = apiMock.mock.calls.find(([p]) => p.endsWith("bulk-delete/"))!
    expect(call[0]).toBe("/api/eol/custom-products/bulk-delete/")
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      ids: ["e1", "e2"],
      dry_run: true,
    })
  })

  it("opens the bulk edit with the server's fields", async () => {
    mount()
    const bar = await tickAll()
    fireEvent.click(bar.getByRole("button", { name: /Edit/ }))
    expect(await screen.findByText("Edit 2 products")).toBeTruthy()
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          ([p]) => p === "/api/eol/custom-products/bulk-edit-fields/"
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
