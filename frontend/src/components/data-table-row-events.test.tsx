// @vitest-environment jsdom
import { createPortal } from "react-dom"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DataTable, isRowClick, selectionColumn } from "@/components/data-table"

// Opt-in row hover and click (#247: a table beside a floor plan points at
// the rack under the pointer and focuses the one clicked). Off by default,
// and a click on a cell's own control stays that control's.

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
  group: string
}
const ROWS: Row[] = [
  { id: "1", name: "A01", group: "Hall 1" },
  { id: "2", name: "A02", group: "Hall 1" },
]

const COLUMNS: ColumnDef<Row>[] = [
  selectionColumn<Row>(),
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <span>
        <a href={`#/racks/${row.original.id}`}>{row.original.name}</a>
        <span data-testid={`text-${row.original.id}`}> rack</span>
      </span>
    ),
  },
  {
    id: "tools",
    header: "Tools",
    cell: ({ row }) => (
      <span>
        <button type="button">Edit {row.original.name}</button>
        <input aria-label={`Note ${row.original.name}`} />
        <span role="switch" aria-checked="false">
          Pin {row.original.name}
        </span>
        {createPortal(
          <div role="menuitem">Delete {row.original.name}</div>,
          document.body
        )}
      </span>
    ),
  },
  { id: "group", accessorKey: "group", header: "Group" },
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
      <DataTable data={ROWS} columns={COLUMNS} embedded {...props} />
    </QueryClientProvider>
  )
}

const rowOf = (text: string) =>
  screen.getByText(text).closest("tr") as HTMLTableRowElement

describe("DataTable onRowClick", () => {
  it("reports a click on the row's own surface", () => {
    const onRowClick = vi.fn()
    mount({ onRowClick })
    fireEvent.click(screen.getByTestId("text-2"))
    // A plain cell.
    fireEvent.click(screen.getAllByText("Hall 1")[0])
    expect(onRowClick.mock.calls.map((c) => c[0].name)).toEqual(["A02", "A01"])
    expect(rowOf("A01").className).toContain("cursor-pointer")
  })

  it("leaves links, checkboxes, buttons, inputs and other controls alone", () => {
    const onRowClick = vi.fn()
    mount({ onRowClick })
    fireEvent.click(screen.getByText("A01")) // the name link
    fireEvent.click(screen.getByText("Edit A01"))
    fireEvent.click(screen.getByLabelText("Note A01"))
    fireEvent.click(screen.getByText("Pin A01"))
    fireEvent.click(screen.getAllByRole("checkbox")[1]) // a row's tick
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it("ignores a click in a menu a cell opened, which React bubbles through the portal", () => {
    const onRowClick = vi.fn()
    mount({ onRowClick })
    fireEvent.click(screen.getByText("Delete A01"))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it("ignores the end of a text selection", () => {
    const onRowClick = vi.fn()
    mount({ onRowClick })
    const text = screen.getByTestId("text-1")
    const range = document.createRange()
    range.selectNodeContents(text)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.click(text)
    expect(onRowClick).not.toHaveBeenCalled()
    sel.removeAllRanges()
    fireEvent.click(text)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })
})

describe("DataTable onRowHover", () => {
  it("names the row under the pointer, and none once it leaves the rows", () => {
    const onRowHover = vi.fn()
    mount({ onRowHover })
    fireEvent.mouseEnter(rowOf("A01"))
    fireEvent.mouseEnter(rowOf("A02"))
    // Onto the name link in the same row: still that row, no new report.
    fireEvent.mouseOver(screen.getByText("A02"), {
      relatedTarget: screen.getByTestId("text-2"),
    })
    fireEvent.mouseLeave(rowOf("A02").parentElement!)
    expect(onRowHover.mock.calls.map((c) => c[0]?.name ?? null)).toEqual([
      "A01",
      "A02",
      null,
    ])
  })

  it("names none over a group banner", () => {
    const onRowHover = vi.fn()
    mount({ onRowHover, groupBy: "group" })
    const banner = screen.getByRole("button", { name: /Hall 1/ }).closest("tr")!
    fireEvent.mouseEnter(banner)
    expect(onRowHover).toHaveBeenLastCalledWith(null)
  })
})

describe("DataTable without row handlers", () => {
  it("is unchanged: no pointer cursor, and a row click does nothing", () => {
    const { container } = mount()
    const row = rowOf("A01")
    expect(row.className).not.toContain("cursor-pointer")
    // Nothing throws, nothing listens.
    fireEvent.click(screen.getByTestId("text-1"))
    fireEvent.mouseEnter(row)
    expect(container.querySelectorAll(".cursor-pointer")).toHaveLength(0)
  })
})

describe("isRowClick", () => {
  it("rejects a prevented click and one from outside the row", () => {
    const row = document.createElement("tr")
    const cell = document.createElement("td")
    row.append(cell)
    expect(isRowClick({ target: cell, currentTarget: row })).toBe(true)
    expect(
      isRowClick({ target: cell, currentTarget: row, defaultPrevented: true })
    ).toBe(false)
    expect(
      isRowClick({ target: document.createElement("div"), currentTarget: row })
    ).toBe(false)
    const opt = document.createElement("span")
    opt.dataset.rowClick = "ignore"
    cell.append(opt)
    expect(isRowClick({ target: opt, currentTarget: row })).toBe(false)
  })
})
