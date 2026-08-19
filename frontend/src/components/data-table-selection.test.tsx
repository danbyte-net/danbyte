// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DataTable, selectionColumn } from "@/components/data-table"

/**
 * The tenants page crashed with React #185 (maximum update depth). The chain:
 * a `useMutation` object in a `useMemo` dep made `columns` - and the filtered
 * rows derived from them - a new identity every render; DataTable then emitted
 * a fresh selection array on every render; the parent stored it in state; that
 * re-rendered the page. Forever.
 *
 * The table now only emits when the selection actually changed, so an unstable
 * upstream identity can no longer drive a loop.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

interface Row {
  id: string
  name: string
}
const ROWS: Row[] = [{ id: "1", name: "Default" }]

afterEach(cleanup)

describe("DataTable selection", () => {
  it("does not re-emit an unchanged selection when data identity churns", () => {
    const onSelected = vi.fn()

    function Harness() {
      const [, setSelected] = useState<Row[]>([])
      // Reproduces the bug's shape: both props are a fresh identity on every
      // render, exactly like a memo keyed on an unstable dependency.
      const columns: ColumnDef<Row>[] = [
        selectionColumn<Row>(),
        { id: "name", accessorKey: "name", header: "Name" },
      ]
      return (
        <DataTable
          data={[...ROWS]}
          columns={columns}
          onSelectedRowsChange={(rows) => {
            onSelected(rows)
            setSelected(rows) // parent stores it - the loop's fuel
          }}
        />
      )
    }

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>
    )
    expect(screen.getByText("Default")).toBeTruthy()
    // Before the guard this ran away until React threw #185. One emit for the
    // initial empty selection is enough; nothing changed after that.
    expect(onSelected.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
