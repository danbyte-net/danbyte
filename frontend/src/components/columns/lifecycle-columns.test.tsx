// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { flexRender } from "@tanstack/react-table"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { LifecycleRow } from "@/lib/api"
import { facetParams, useTableFilters } from "@/components/table-filters"
import {
  WINDOW_PARAMS,
  buildLifecycleColumns,
  daysLeftSortValue,
} from "./lifecycle-columns"

// The Lifecycle page's table (#436): one row per object per source, bucketed
// into fixed windows that a deep link (/lifecycle?source=coverage&window=90)
// can tick, sorted by days left with the undated rows last.

vi.mock("@/lib/use-me", () => ({ useMe: () => ({ me: {} }) }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))

afterEach(cleanup)

function row(patch: Partial<LifecycleRow> & { name: string }): LifecycleRow {
  const { name, ...rest } = patch
  return {
    object: { id: name, name, kind: "device" },
    source: "hardware",
    item: { type: "devicetype", id: "dt", name: "C9300" },
    status: "supported",
    start: null,
    end: "2027-01-01",
    days_left: 200,
    window: "y1",
    site: null,
    role: null,
    tenant: { id: "t", name: "Acme" },
    manufacturer: null,
    tags: [],
    ...rest,
  }
}

const ROWS: LifecycleRow[] = [
  row({ name: "gone", status: "eol", days_left: -20, window: "past" }),
  row({
    name: "flagged",
    source: "os",
    status: "eol",
    end: null,
    days_left: null,
    window: "past",
    item: {
      type: "platform",
      id: "p",
      name: "Legacy",
      date_source: "endoflife_date",
    },
  }),
  row({
    name: "soon",
    source: "coverage",
    status: "expiring",
    days_left: 40,
    window: "d90",
    item: { type: "supportcontract", id: null, name: "Contract" },
  }),
  row({
    name: "open",
    source: "coverage",
    status: "covered",
    end: null,
    days_left: null,
    window: "later",
    item: { type: "supportcontract", id: "k", name: "K-1" },
  }),
  row({ name: "later", days_left: 900, window: "later" }),
  row({
    name: "bare",
    source: "coverage",
    status: "none",
    end: null,
    days_left: null,
    window: "none",
    item: null,
  }),
]

const columns = (): ColumnDef<LifecycleRow, unknown>[] =>
  buildLifecycleColumns({
    windows: { eol_warning_days: 180, coverage_warning_days: 90 },
  })

function pick(facet: string, ...values: string[]): string[] {
  const { result } = renderHook(() => useTableFilters(columns(), ROWS))
  for (const v of values) act(() => result.current.toggleValue(facet, v))
  return result.current.filteredRows.map((r) => r.object.name)
}

function cell(id: string, r: LifecycleRow) {
  const col = columns().find((c) => c.id === id)!
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      {flexRender(col.cell, { row: { original: r } } as never)}
    </QueryClientProvider>
  )
}

describe("lifecycle columns", () => {
  it("keep the facets under the params a deep link uses", () => {
    const entries = columns()
      .filter((c) => c.meta?.facet)
      .map((c) => ({ id: c.id!, def: c.meta!.facet! }))
    const params = Object.fromEntries(
      [...facetParams(entries)].map(([id, p]) => [id, p.param])
    )
    expect(params).toMatchObject({
      source: "source",
      window: "window",
      status: "status",
      site: "site",
      role: "role",
      manufacturer: "manufacturer",
      kind: "kind",
      tags: "tag",
    })
  })

  it("bucket rows by window, the same scale for every source", () => {
    expect(WINDOW_PARAMS.d90).toBe("90")
    expect(pick("window", "past")).toEqual(["gone", "flagged"])
    expect(pick("window", "90")).toEqual(["soon"])
    expect(pick("window", "later")).toEqual(["open", "later"])
    expect(pick("source", "coverage")).toEqual(["soon", "open", "bare"])
    expect(pick("status", "eol")).toEqual(["gone", "flagged"])
  })

  it("name each status in its source's words", () => {
    const { result } = renderHook(() => useTableFilters(columns(), ROWS))
    render(<div>{result.current.rail}</div>)
    for (const label of ["End of life", "Expiring", "Covered", "Not covered"])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
  })

  it("sort by days left: a dateless past first, the undated last", () => {
    const order = [...ROWS]
      .sort((a, b) => daysLeftSortValue(a) - daysLeftSortValue(b))
      .map((r) => r.object.name)
    expect(order).toEqual(["flagged", "gone", "soon", "later", "open", "bare"])
  })

  it("export the end date for the bar and the label for the status", () => {
    const meta = (id: string) =>
      columns().find((c) => c.id === id)!.meta!.export!
    expect(meta("lifetime").value(ROWS[0])).toBe("2027-01-01")
    expect(meta("lifetime").value(ROWS[1])).toBe("")
    expect(meta("status").value(ROWS[2])).toBe("Expiring")
    expect(meta("window").value(ROWS[5])).toBe("No date")
  })

  it("draw a pill where there is no end, and hide a contract's number", () => {
    cell("lifetime", ROWS[3])
    expect(screen.getByText("Open-ended")).toBeTruthy()
    cleanup()
    cell("lifetime", ROWS[1])
    expect(screen.getByText("End of life")).toBeTruthy()
    cleanup()
    cell("lifetime", ROWS[5])
    expect(document.body.textContent).toBe("-")
    cleanup()
    cell("item", ROWS[2])
    expect(screen.getByText("Contract").tagName).toBe("SPAN")
  })

  it("name installed software by application and version", () => {
    const sw = row({
      name: "db1",
      source: "software",
      status: "ending",
      item: {
        type: "application",
        id: "a",
        name: "PostgreSQL 12",
        application: "PostgreSQL",
        version: "12",
        date_source: "endoflife_date",
      },
    })
    cell("item", sw)
    expect(screen.getByText("PostgreSQL 12").tagName).toBe("A")
    const source = columns().find((c) => c.id === "source") as {
      accessorFn: (r: LifecycleRow, i: number) => unknown
    }
    expect(source.accessorFn(sw, 0)).toBe("Software")
  })

  it("hide the application, window, tenant and tags columns until asked", () => {
    const hidden = columns()
      .filter((c) => c.meta?.defaultHidden)
      .map((c) => c.id)
    expect(hidden).toEqual(["application", "window", "tenant", "tags"])
  })

  it("filter software rows by application and link their end", () => {
    const sw = row({
      name: "db1",
      source: "software",
      item: {
        type: "application",
        id: "app-1",
        name: "PostgreSQL 12",
        application: "PostgreSQL",
        version: "12",
      },
    })
    const rows = [...ROWS, sw]
    const { result } = renderHook(() => useTableFilters(columns(), rows))
    act(() => result.current.toggleValue("application", "app-1"))
    expect(result.current.filteredRows.map((r) => r.object.name)).toEqual([
      "db1",
    ])
    cell("end", sw)
    expect(screen.getByText(/2027/).closest("a")).not.toBeNull()
    cleanup()
    cell("end", ROWS[0])
    expect(screen.getByText(/2027/).closest("a")).toBeNull()
  })
})
