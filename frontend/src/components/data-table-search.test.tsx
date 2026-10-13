// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import {
  DataTable,
  matchesSearch,
  searchAccessor,
} from "@/components/data-table"

// The table's search box matches the words a row shows: object references by
// name, columns whose first row is empty, export-text columns and cell-only
// columns named after a row field - and never a hidden column.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
afterEach(cleanup)

interface Row {
  id: string
  name: string
  serial: string | null
  site: { id: string; name: string } | null
  tags: { id: string; name: string }[]
  status: { id: string; name: string }
  description: string
  secret: string
}
const ROWS: Row[] = [
  {
    id: "1",
    name: "sw-core-01",
    serial: null,
    site: null,
    tags: [],
    status: { id: "s1", name: "Active" },
    description: "",
    secret: "zzz",
  },
  {
    id: "2",
    name: "sw-edge-02",
    serial: "FDO1234",
    site: { id: "a", name: "Aarhus" },
    tags: [{ id: "t", name: "uplink" }],
    status: { id: "s2", name: "Planned" },
    description: "rack B rear",
    secret: "hidden-word",
  },
]

const COLUMNS: ColumnDef<Row>[] = [
  { id: "name", accessorKey: "name", header: "Name" },
  // First row null: TanStack's default would drop the column from search.
  { id: "serial", accessorKey: "serial", header: "Serial" },
  // Object values read as their names.
  { id: "site", accessorKey: "site", header: "Site" },
  { id: "tags", accessorKey: "tags", header: "Tags" },
  // Cell-only column with export text.
  {
    id: "state",
    header: "Status",
    cell: ({ row }) => row.original.status.name,
    meta: { export: { value: (r) => r.status.name } },
  },
  // Cell-only column named after a row field.
  {
    id: "description",
    header: "Description",
    cell: ({ row }) => row.original.description,
  },
  { id: "secret", accessorKey: "secret", header: "Secret" },
]

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(["user-prefs"], {
    values: { page_size: 25 },
    defaults: {},
    user_set: [],
  })
  return render(
    <QueryClientProvider client={qc}>
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        embedded
        searchable
        searchPlaceholder="Search devices…"
        initialColumnVisibility={{ secret: false }}
      />
    </QueryClientProvider>
  )
}

function search(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Search devices…"), {
    target: { value: text },
  })
}

const shown = () =>
  ROWS.filter((r) => screen.queryByText(r.name)).map((r) => r.name)

describe("DataTable search box", () => {
  it("matches a column whose first row is empty", () => {
    mount()
    search("fdo12")
    expect(shown()).toEqual(["sw-edge-02"])
  })

  it("matches object and list values by name", () => {
    mount()
    search("aarhus")
    expect(shown()).toEqual(["sw-edge-02"])
    search("UPLINK")
    expect(shown()).toEqual(["sw-edge-02"])
  })

  it("matches export text and cell-only row fields", () => {
    mount()
    search("planned")
    expect(shown()).toEqual(["sw-edge-02"])
    search("rack b")
    expect(shown()).toEqual(["sw-edge-02"])
  })

  it("ignores hidden columns and blank queries", () => {
    mount()
    search("hidden-word")
    expect(shown()).toEqual([])
    expect(screen.getByText("No results.")).toBeTruthy()
    search("   ")
    expect(shown()).toEqual(["sw-core-01", "sw-edge-02"])
  })
})

describe("matchesSearch", () => {
  it("is a trimmed, case-insensitive substring match", () => {
    expect(matchesSearch("10.0.0.41/24", " 0.0.4 ")).toBe(true)
    expect(matchesSearch("Core", "core")).toBe(true)
    expect(matchesSearch("Core", "edge")).toBe(false)
    expect(matchesSearch("", "")).toBe(true)
  })
})

describe("searchAccessor", () => {
  it("gives a cell-only column a read-only accessor", () => {
    const col = searchAccessor<Row>({
      id: "description",
      header: "Description",
      cell: () => null,
    }) as ColumnDef<Row> & { accessorFn: (r: Row) => unknown }
    expect(col.accessorFn(ROWS[1])).toBe("rack B rear")
    expect(col.enableSorting).toBe(false)
    expect(col.meta?.searchOnly).toBe(true)
  })

  it("leaves accessor and control columns alone", () => {
    const named = COLUMNS[0]
    expect(searchAccessor(named)).toBe(named)
    const actions: ColumnDef<Row> = { id: "actions", cell: () => null }
    expect(searchAccessor(actions)).toBe(actions)
  })
})
