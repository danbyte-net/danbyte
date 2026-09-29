// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import { DataTable, SortHeader } from "./data-table"

// #244: a header click sorted text with a plain compare - DIMM 1, DIMM 10,
// DIMM 11, DIMM 2 - on any table of ten rows or fewer.
type Row = { id: string; name: string; size: number }
// Sizes a text compare would misorder (1.5 before 1.25), in a different
// order from the names.
const SIZE: Record<number, number> = {
  11: 1.25,
  2: 1.5,
  10: 0.75,
  1: 2,
  3: 1.125,
}
const rows: Row[] = [11, 2, 10, 1, 3].map((n) => ({
  id: String(n),
  name: `DIMM ${n}`,
  size: SIZE[n],
}))
const columns: ColumnDef<Row>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: ({ column }) => <SortHeader column={column} label="Name" />,
    cell: ({ row }) => <span data-testid="name">{row.original.name}</span>,
  },
  {
    id: "size",
    accessorKey: "size",
    header: ({ column }) => <SortHeader column={column} label="Size" />,
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

const names = () => screen.getAllByTestId("name").map((e) => e.textContent)

describe("DataTable default sorting", () => {
  it("sorts names with numbers in natural order", () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <DataTable data={rows} columns={columns} />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /^name/i }))
    expect(names()).toEqual([
      "DIMM 1",
      "DIMM 2",
      "DIMM 3",
      "DIMM 10",
      "DIMM 11",
    ])
    fireEvent.click(screen.getByRole("button", { name: /^name/i }))
    expect(names()).toEqual([
      "DIMM 11",
      "DIMM 10",
      "DIMM 3",
      "DIMM 2",
      "DIMM 1",
    ])
  })

  it("still sorts numbers by value", () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <DataTable data={rows} columns={columns} />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /^size/i }))
    expect(names()).toEqual([
      "DIMM 10",
      "DIMM 3",
      "DIMM 11",
      "DIMM 2",
      "DIMM 1",
    ])
  })
})
