// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { flexRender } from "@tanstack/react-table"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import { tagsColumn } from "@/components/cells/tag-list"
import { useUrlTableFilters } from "@/components/table-filters"
import type { FilterSnapshot } from "@/components/table-filters"
import type { Tag } from "@/lib/api"

// List filters live in the URL (lib/url-filters). A real in-memory router,
// because the behaviour that matters is the router's: what the address says,
// and whether a filter change added a Back step.

interface Row {
  id: string
  name: string
  status: string
  util: number
  tags: Tag[]
}

const tag = (id: number, slug: string): Tag => ({
  id,
  slug,
  name: slug.toUpperCase(),
  color: "",
  text_color: "",
})

const ROWS: Row[] = [
  {
    id: "1",
    name: "sw-01",
    status: "active",
    util: 80,
    tags: [tag(7, "core")],
  },
  {
    id: "2",
    name: "sw-02",
    status: "planned",
    util: 20,
    tags: [tag(8, "edge")],
  },
  { id: "3", name: "sw-03", status: "active", util: 40, tags: [] },
]

const COLUMNS: ColumnDef<Row, unknown>[] = [
  { id: "name", accessorKey: "name" },
  {
    id: "status",
    accessorKey: "status",
    meta: {
      facet: { kind: "enum", label: "Status", get: (r: Row) => r.status },
    },
  },
  {
    id: "util",
    accessorKey: "util",
    meta: { facet: { kind: "range", label: "Util", get: (r: Row) => r.util } },
  },
  tagsColumn<Row>({ getTags: (r) => r.tags }),
]

let restoreRef: ((s: FilterSnapshot | null) => void) | null = null

function List() {
  const { filteredRows, activeCount, columns, restore } = useUrlTableFilters(
    COLUMNS,
    ROWS
  )
  restoreRef = restore
  const tagsCol = columns.find((c) => c.id === "tags")!
  return (
    <div>
      <p data-testid="rows">{filteredRows.map((r) => r.name).join(" ")}</p>
      <p data-testid="active">{activeCount}</p>
      {ROWS.map((r) => (
        <div key={r.id} data-testid={`tags-${r.id}`}>
          {flexRender(tagsCol.cell, {
            row: { original: r },
            column: { columnDef: tagsCol },
          } as never)}
        </div>
      ))}
    </div>
  )
}

function makeRouter(url: string) {
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/things",
    component: List,
    // A typed legacy deep-link param, as /devices declares `status`: the
    // facet must still read it (and the params the route never declared).
    validateSearch: (s: Record<string, unknown>): { status?: string } =>
      typeof s.status === "string" ? { status: s.status } : {},
  })
  return createRouter({
    routeTree: root.addChildren([list]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
}

async function mount(url: string) {
  const router = makeRouter(url)
  render(<RouterProvider router={router as never} />)
  await screen.findByTestId("rows")
  return router
}

const rows = () => screen.getByTestId("rows").textContent
const search = (router: ReturnType<typeof makeRouter>) =>
  router.state.location.search as Record<string, unknown>

afterEach(() => {
  cleanup()
  restoreRef = null
})

describe("useUrlTableFilters", () => {
  it("applies a deep link - the legacy single-value param included", async () => {
    await mount("/things?status=active")
    expect(rows()).toBe("sw-01 sw-03")
    expect(screen.getByTestId("active").textContent).toBe("1")
  })

  it("reads several values, a tag and a range together", async () => {
    await mount("/things?status=active,planned&tag=core&util=50..")
    expect(rows()).toBe("sw-01")
  })

  it("ignores a value no row carries instead of emptying the list", async () => {
    await mount("/things?status=bogus&tag=gone")
    expect(rows()).toBe("sw-01 sw-02 sw-03")
    expect(screen.getByTestId("active").textContent).toBe("0")
  })

  it("filters by the advanced expression in ?expr=", async () => {
    await mount(`/things?expr=${encodeURIComponent('name = "sw-02"')}`)
    expect(rows()).toBe("sw-02")
  })

  it("a tag chip click writes ?tag= by REPLACE, and a second click clears it", async () => {
    const router = await mount("/things?q=sw")
    const before = router.history.length
    fireEvent.click(
      screen.getByTestId("tags-1").querySelector("[data-slot=badge]")!
    )
    await waitFor(() => expect(search(router).tag).toBe("core"))
    expect(rows()).toBe("sw-01")
    expect(search(router).q).toBe("sw")
    expect(router.history.length).toBe(before)

    fireEvent.click(
      screen.getByTestId("tags-1").querySelector("[data-slot=badge]")!
    )
    await waitFor(() => expect(search(router).tag).toBeUndefined())
    expect(rows()).toBe("sw-01 sw-02 sw-03")
  })

  it("two tags OR together in one comma-separated param", async () => {
    const router = await mount("/things?tag=core")
    fireEvent.click(
      screen.getByTestId("tags-2").querySelector("[data-slot=badge]")!
    )
    await waitFor(() => expect(search(router).tag).toBe("core,edge"))
    expect(rows()).toBe("sw-01 sw-02")
  })

  it("restores a saved view into the URL, replacing what was there", async () => {
    const router = await mount("/things?status=planned&tag=edge")
    act(() =>
      restoreRef!({
        status: ["active"],
        util: { min: "50", max: "" },
        __expr: "util > 1",
      })
    )
    await waitFor(() => expect(search(router).status).toBe("active"))
    expect(search(router).tag).toBeUndefined()
    expect(search(router).util).toBe("50..")
    expect(search(router).expr).toBe("util > 1")
    expect(rows()).toBe("sw-01")

    act(() => restoreRef!(null))
    await waitFor(() => expect(search(router).status).toBeUndefined())
    expect(search(router).util).toBeUndefined()
    expect(search(router).expr).toBeUndefined()
  })
})
