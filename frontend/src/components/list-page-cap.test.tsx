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
import type { ColumnDef } from "@tanstack/react-table"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DataTable } from "@/components/data-table"
import { FilterRail } from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { listCap, listCapNotice } from "@/lib/list-cap"
import { toHtml } from "@/lib/table-export"

// A list page fetches its rows in one capped request. When the server holds
// more than arrived, the page must say so - the count chip, a notice, the
// facet rail and the Download - instead of reading as complete (#412).

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
    humanIds: false,
  }),
  objCan: () => true,
}))
apiMock.mockImplementation((path: string) =>
  path.startsWith("/api/prefs/columns/")
    ? Promise.resolve({ source: "none", is_forced: false, data: null })
    : new Promise(() => undefined)
)

afterEach(cleanup)

function mount(node: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

interface Row {
  id: string
  name: string
}
const COLUMNS: ColumnDef<Row, unknown>[] = [
  { id: "name", accessorKey: "name", header: "Name" },
]

function listOf(loaded: number, total: number) {
  const results = Array.from({ length: loaded }, (_, i) => ({
    id: String(i),
    name: `ip-${i}`,
  }))
  return { count: total, results }
}

function List({ data }: { data: { count: number; results: Row[] } }) {
  return (
    <ListPageShell
      title="IP addresses"
      count={data.results.length}
      page={data}
      rail={
        <FilterRail>
          <p>facets</p>
        </FilterRail>
      }
    >
      <DataTable data={data.results} columns={COLUMNS} />
    </ListPageShell>
  )
}

function openDownload() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Download/ }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
}

describe("listCap", () => {
  it("is null when every row arrived", () => {
    expect(listCap(undefined)).toBeNull()
    expect(listCap({ count: 3, results: [1, 2, 3] })).toBeNull()
    expect(listCap({ results: [1] })).toBeNull()
  })

  it("names the loaded rows and the server's count", () => {
    const cap = listCap({ count: 40960, results: new Array(1000) })
    expect(cap).toEqual({ loaded: 1000, total: 40960 })
    expect(listCapNotice(cap!)).toBe(
      "Showing the first 1,000 of 40,960 - search to narrow the list."
    )
  })
})

describe("capped list page", () => {
  it("says so in the chip, a notice, the rail and the Download", async () => {
    mount(<List data={listOf(5, 40960)} />)
    expect(await screen.findByText("5 of 40,960")).toBeTruthy()
    expect(
      screen.getByText(
        "Showing the first 5 of 40,960 - search to narrow the list."
      )
    ).toBeTruthy()
    expect(screen.getByText("Counts cover the first 5 of 40,960.")).toBeTruthy()
    openDownload()
    expect(await screen.findByText("First 5 of 40,960 rows")).toBeTruthy()
  })

  it("stays quiet when the list is whole", async () => {
    mount(<List data={listOf(5, 5)} />)
    expect(await screen.findByText("5")).toBeTruthy()
    expect(screen.queryByText(/Showing the first/)).toBeNull()
    expect(screen.queryByText(/Counts cover/)).toBeNull()
    openDownload()
    expect(await screen.findByText("CSV (spreadsheet)")).toBeTruthy()
    expect(screen.queryByText(/^First \d/)).toBeNull()
  })

  it("puts the note on the exported page", () => {
    const html = toHtml(
      [{ id: "name", header: "Name", get: () => "" }],
      [["ip-0"]],
      {
        name: "ips",
        title: "IPs",
        generatedAt: "now",
        note: "First 1,000 of 40,960 rows",
      }
    )
    expect(html).toContain("1 row · First 1,000 of 40,960 rows · exported now")
  })
})
