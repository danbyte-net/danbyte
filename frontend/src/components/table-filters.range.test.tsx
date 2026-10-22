// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import { useTableFilters } from "@/components/table-filters"

// An open range facet (no bounds) renders two number fields; both carry a
// name a screen reader can read (#445).

interface Row {
  id: string
  ips: number
}

const COLUMNS: ColumnDef<Row, unknown>[] = [
  {
    id: "ips",
    accessorKey: "ips",
    meta: { facet: { kind: "range", label: "IPs", get: (r: Row) => r.ips } },
  },
]

function Rail() {
  const { rail } = useTableFilters(COLUMNS, [
    { id: "1", ips: 2 },
    { id: "2", ips: 5 },
  ])
  return <>{rail}</>
}

afterEach(cleanup)

describe("range facet", () => {
  it("labels both of its fields", () => {
    render(<Rail />)
    expect(screen.getByRole("spinbutton", { name: "Minimum IPs" })).toBeTruthy()
    expect(screen.getByRole("spinbutton", { name: "Maximum IPs" })).toBeTruthy()
  })
})
