// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DataTable } from "./data-table"

// A table wider than its frame gets the floating proxy scrollbar and the
// right-edge hint; one that fits gets neither.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type Row = { id: string; a: string }
const columns: ColumnDef<Row, unknown>[] = [
  { id: "a", accessorKey: "a", header: "A" },
]

function mount(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
    scrollWidth
  )
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    clientWidth
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataTable
        data={[{ id: "1", a: "x" }]}
        columns={columns}
        autoColumns={false}
      />
    </QueryClientProvider>
  )
}

describe("DataTable horizontal scroll", () => {
  it("renders the proxy scrollbar when the table overflows", () => {
    const { container } = mount(1200, 400)
    const proxy = container.querySelector("[data-slot=table-scroll-proxy]")
    expect(proxy).not.toBeNull()
    const spacer = proxy?.firstElementChild as HTMLElement
    expect(spacer.style.width).toBe("1200px")
    const scroller = container.querySelector("[data-slot=table-container]")
    expect(scroller?.hasAttribute("data-scroll-proxy")).toBe(true)
    expect(scroller?.parentElement?.hasAttribute("data-scroll-right")).toBe(
      true
    )
  })

  it("renders no proxy when the table fits", () => {
    const { container } = mount(400, 400)
    expect(container.querySelector("[data-slot=table-scroll-proxy]")).toBeNull()
    const scroller = container.querySelector("[data-slot=table-container]")
    expect(scroller?.parentElement?.hasAttribute("data-scroll-right")).toBe(
      false
    )
  })
})
