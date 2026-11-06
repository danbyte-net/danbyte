// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import { DataTable, selectionColumn } from "@/components/data-table"

// Grouped tables page by default (#479): 5,000 grouped prefixes in the DOM
// froze the Prefixes list. The header checkbox ticks the page's rows, not
// the whole group a banner on the page stands for.

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
  grp: string
}
const ROWS: Row[] = Array.from({ length: 60 }, (_, i) => ({
  id: String(i),
  name: `row-${i}`,
  grp: i < 50 ? "A" : "B",
}))
const COLUMNS: ColumnDef<Row>[] = [
  selectionColumn<Row>(),
  { id: "grp", accessorKey: "grp", header: "Group" },
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => <span data-testid="name">{row.original.name}</span>,
  },
]

function mount(
  props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}
) {
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
        groupBy="grp"
        tableId="t"
        {...props}
      />
    </QueryClientProvider>
  )
}

describe("DataTable grouped paging", () => {
  it("pages a grouped table by default", () => {
    mount()
    // 25 rows a page, the first group's banner among them.
    expect(screen.getAllByTestId("name")).toHaveLength(24)
  })

  it("shows the whole hierarchy when the table opts out", () => {
    mount({ pagedWhenGrouped: false })
    expect(screen.getAllByTestId("name")).toHaveLength(60)
  })

  it("ticks the page's rows, not the banner's whole group", () => {
    mount()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    expect(screen.getByText("24 selected")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Select all 60" }))
    expect(screen.getByText("60 selected")).toBeTruthy()
  })
})
