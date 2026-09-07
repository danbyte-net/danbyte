// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import { DataTable, SortHeader } from "./data-table"

type Row = { id: string; grp: string; status: string }
const rows: Row[] = [
  { id: "a", grp: "G", status: "Active" },
  { id: "b", grp: "G", status: "" },
  { id: "c", grp: "G", status: "Reserved" },
]
const columns: ColumnDef<Row>[] = [
  { id: "grp", accessorKey: "grp", header: "Group" },
  {
    id: "status",
    accessorFn: (r) => r.status,
    header: ({ column }) => <SortHeader column={column} label="Status" />,
    cell: ({ row }) => <span data-testid="status">{row.original.status || "-"}</span>,
  },
]

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataTable data={rows} columns={columns} groupBy="grp" tableId="t" />
    </QueryClientProvider>
  )
}

describe("DataTable sorting inside a grouped table", () => {
  it("reorders the group's rows when a sortable header is clicked", () => {
    mount()
    const before = screen.getAllByTestId("status").map((e) => e.textContent)
    expect(before).toEqual(["Active", "-", "Reserved"])
    fireEvent.click(screen.getByRole("button", { name: /status/i }))
    const asc = screen.getAllByTestId("status").map((e) => e.textContent)
    expect(asc).toEqual(["-", "Active", "Reserved"])
  })
})
