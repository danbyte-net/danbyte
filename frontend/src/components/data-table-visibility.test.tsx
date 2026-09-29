// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import { DataTable, applyManageableOrder, carryUnmounted } from "./data-table"
import type { ColumnPref } from "@/lib/api"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)

type Row = { id: string; a: string; b: string; extra: string; late: string }
const rows: Row[] = [{ id: "1", a: "A1", b: "B1", extra: "E1", late: "L1" }]

const col = (id: keyof Row, hidden = false): ColumnDef<Row, unknown> => ({
  id,
  accessorKey: id,
  header: id.toUpperCase(),
  meta: hidden ? { defaultHidden: true } : undefined,
})
const BASE = [col("a"), col("b"), col("extra", true)]

function client(pref: ColumnPref["data"] | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData<ColumnPref>(["col-pref", "t"], {
    source: pref ? "user" : "none",
    is_forced: false,
    data: pref,
  })
  return qc
}

function headers() {
  return screen.getAllByRole("columnheader").map((h) => h.textContent)
}

function mount(
  qc: QueryClient,
  columns: ColumnDef<Row, unknown>[] = BASE,
  initial?: Record<string, boolean>
) {
  return render(
    <QueryClientProvider client={qc}>
      <DataTable
        data={rows}
        columns={columns}
        tableId="t"
        autoColumns={false}
        initialColumnVisibility={initial}
      />
    </QueryClientProvider>
  )
}

describe("DataTable column visibility", () => {
  it("hides a default-hidden column until a layout shows it", () => {
    mount(client(null))
    expect(headers()).toEqual(["A", "B"])
  })

  it("keeps a ticked default-hidden column shown after a remount", () => {
    const qc = client({ order: ["a", "b", "extra"], hidden: [] })
    mount(qc)
    expect(headers()).toEqual(["A", "B", "EXTRA"])
    cleanup()
    mount(qc)
    expect(headers()).toEqual(["A", "B", "EXTRA"])
  })

  it("shows a column the page hides by default when the layout ticked it", () => {
    mount(client({ order: ["a", "b"], hidden: [] }), [col("a"), col("b")], {
      b: false,
    })
    expect(headers()).toEqual(["A", "B"])
  })

  it("reads a legacy hidden-only layout as before", () => {
    mount(client({ order: [], hidden: ["b"] }))
    expect(headers()).toEqual(["A"])
  })

  it("keeps a late-mounting default-hidden column hidden", () => {
    const qc = client({ order: ["a", "b"], hidden: [] })
    const { rerender } = mount(qc)
    rerender(
      <QueryClientProvider client={qc}>
        <DataTable
          data={rows}
          columns={[...BASE, col("late", true)]}
          tableId="t"
          autoColumns={false}
        />
      </QueryClientProvider>
    )
    expect(headers()).toEqual(["A", "B"])
  })

  it("returns to the defaults when the layout is cleared", () => {
    const qc = client({ order: ["b", "a", "extra"], hidden: ["a"] })
    const { rerender } = mount(qc)
    expect(headers()).toEqual(["B", "EXTRA"])
    qc.setQueryData<ColumnPref>(["col-pref", "t"], {
      source: "none",
      is_forced: false,
      data: null,
    })
    rerender(
      <QueryClientProvider client={qc}>
        <DataTable data={rows} columns={BASE} tableId="t" autoColumns={false} />
      </QueryClientProvider>
    )
    expect(headers()).toEqual(["A", "B"])
  })
})

describe("column order helpers", () => {
  it("anchors a new column on its nearest shown predecessor", () => {
    // Saved: shown a, c; hidden b in the tail. New "n" is designed after b.
    const ids = ["a", "b", "n", "c"]
    const order = applyManageableOrder(
      ids,
      ids,
      ["a", "c", "b"],
      (id) => id !== "b"
    )
    expect(order).toEqual(["a", "n", "c", "b"])
  })

  it("carries saved columns the menu could not show", () => {
    expect(
      carryUnmounted(["a", "b"], ["a", "site.region", "b"], new Set(["a", "b"]))
    ).toEqual(["a", "site.region", "b"])
  })
})
