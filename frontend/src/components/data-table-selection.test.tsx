// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  DataTable,
  hasDistinctIds,
  selectionColumn,
} from "@/components/data-table"

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

const COLUMNS: ColumnDef<Row>[] = [
  selectionColumn<Row>(),
  { id: "name", accessorKey: "name", header: "Name" },
]

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `vlan ${i}`,
  }))
}

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // 25 rows a page, without asking the server for the preference.
  qc.setQueryData(["user-prefs"], {
    values: { page_size: 25 },
    defaults: {},
    user_set: [],
  })
  return qc
}

// A list page in miniature: the parent keeps the selection, as the bulk bars
// expect, and can empty it the way a bar's Clear does.
function mountList(initial: Row[]) {
  const seen: Row[][] = []
  let setData: (rows: Row[]) => void = () => {}
  let clear: () => void = () => {}
  function Page() {
    const [data, setRows] = useState(initial)
    const [selected, setSelected] = useState<Row[]>([])
    setData = setRows
    clear = () => setSelected([])
    return (
      <DataTable
        data={data}
        columns={COLUMNS}
        onSelectedRowsChange={(r) => {
          seen.push(r)
          setSelected(r)
        }}
        selectedRows={selected}
      />
    )
  }
  render(
    <QueryClientProvider client={client()}>
      <Page />
    </QueryClientProvider>
  )
  return {
    last: () => (seen.at(-1) ?? []).map((r) => r.name),
    setData: (r: Row[]) => act(() => setData(r)),
    clear: () => act(() => clear()),
  }
}

function tick(name: string) {
  const row = screen.getByText(name).closest("tr")!
  fireEvent.click(row.querySelector('[role="checkbox"]')!)
}

function ticked() {
  return screen
    .queryAllByRole("row")
    .filter((r) => r.getAttribute("data-state") === "selected")
    .map((r) => r.textContent)
}

describe("DataTable selection follows the row, not its position", () => {
  it("keeps the ticked object when the data is filtered or reordered", () => {
    const all = makeRows(3)
    const list = mountList(all)
    tick("vlan 0")
    expect(list.last()).toEqual(["vlan 0"])

    // A filter drops the first row: the tick must not slide onto vlan 1.
    list.setData([all[2], all[0]])
    expect(ticked()).toEqual(["vlan 0"])
    expect(list.last()).toEqual(["vlan 0"])
  })

  it("drops a ticked row that leaves the data", () => {
    const all = makeRows(3)
    const list = mountList(all)
    tick("vlan 1")
    list.setData([all[0], all[2]])
    expect(ticked()).toEqual([])
    expect(list.last()).toEqual([])
    expect(screen.queryByText(/selected/)).toBeNull()
  })

  it("clears the ticks when the parent empties its selection", () => {
    const list = mountList(makeRows(3))
    tick("vlan 0")
    tick("vlan 2")
    expect(ticked()).toHaveLength(2)
    list.clear()
    expect(ticked()).toEqual([])
    // A new tick starts a new selection - the cleared rows stay cleared.
    tick("vlan 1")
    expect(list.last()).toEqual(["vlan 1"])
  })
})

describe("DataTable select all", () => {
  it("offers the rest of the list once the page is ticked", () => {
    const list = mountList(makeRows(30))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    expect(screen.getByText("25 selected")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Select all 30" }))
    expect(screen.getByText("30 selected")).toBeTruthy()
    expect(list.last()).toHaveLength(30)

    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(screen.queryByText(/selected/)).toBeNull()
    expect(list.last()).toEqual([])
  })

  it("says nothing more when the list fits on one page", () => {
    mountList(makeRows(5))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    expect(screen.getByText("5 selected")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Select all/ })).toBeNull()
  })
})

describe("hasDistinctIds", () => {
  it("needs an id on every row and no repeats", () => {
    expect(hasDistinctIds([{ id: "a" }, { id: 2 }])).toBe(true)
    expect(hasDistinctIds([])).toBe(false)
    expect(hasDistinctIds([{ id: "a" }, { name: "b" }])).toBe(false)
    expect(hasDistinctIds([{ id: "a" }, { id: "a" }])).toBe(false)
    expect(hasDistinctIds([{ id: { nested: 1 } }])).toBe(false)
  })
})
