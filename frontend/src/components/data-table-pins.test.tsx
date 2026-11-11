// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DataTable } from "./data-table"
import type { ColumnPref, ColumnPrefData } from "@/lib/api"

// Pinned columns: the saved layout's pins keep their place and stick (the
// row tick too) at offsets measured from their header cells; an
// older layout without pins changes nothing; a narrow frame ignores them.

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>()
  return { ...real, api: vi.fn(() => Promise.resolve({})) }
})
import { api } from "@/lib/api"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(api).mockClear()
})

type Row = { id: string; a: string; b: string; c: string }
const rows: Row[] = [{ id: "1", a: "A1", b: "B1", c: "C1" }]
const col = (id: keyof Row): ColumnDef<Row, unknown> => ({
  id,
  accessorKey: id,
  header: id.toUpperCase(),
})
const select: ColumnDef<Row, unknown> = {
  id: "select",
  header: "SEL",
  cell: () => "x",
  enableHiding: false,
}
const COLUMNS = [select, col("a"), col("b"), col("c")]

function client(pref: ColumnPrefData | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData<ColumnPref>(["col-pref", "t"], {
    source: pref ? "user" : "none",
    is_forced: false,
    data: pref,
  })
  return qc
}

/** Every cell 100px wide, the frame `frame` px. */
function size(frame: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(frame)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
}

function mount(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <DataTable
        data={rows}
        columns={COLUMNS}
        tableId="t"
        autoColumns={false}
      />
    </QueryClientProvider>
  )
}

const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent)
const head = (label: string) =>
  screen.getAllByRole("columnheader").find((h) => h.textContent === label)!

describe("DataTable pinned columns", () => {
  it("keeps a pin in its place and sticks it at the measured offset", () => {
    size(1200)
    const { container } = mount(
      client({ order: ["a", "b", "c"], hidden: [], pinned: ["c"] })
    )
    // No reordering: C stays last, sticking after the tick when passed.
    expect(headers()).toEqual(["SEL", "A", "B", "C"])
    expect(head("SEL").style.left).toBe("0px")
    expect(head("C").style.left).toBe("100px")
    expect(head("A").hasAttribute("data-pinned")).toBe(false)
    const cell = screen.getByText("C1").closest("td")!
    expect(cell.hasAttribute("data-pinned")).toBe(true)
    expect(cell.style.left).toBe("100px")
    // Nothing is stuck before scrolling, so no divider.
    expect(container.querySelector("[data-pin-last]")).toBeNull()
  })

  it("draws the divider on the column that is actually stuck", () => {
    size(1200)
    const { container } = mount(
      client({ order: ["a", "b", "c"], hidden: [], pinned: ["c"] })
    )
    const scroller = container.querySelector<HTMLElement>(
      "[data-slot=table-container]"
    )!
    // C starts at 300 and sticks at 100: only the tick is stuck before 200.
    act(() => {
      scroller.scrollLeft = 150
      fireEvent.scroll(scroller)
    })
    expect(head("SEL").hasAttribute("data-pin-last")).toBe(true)
    act(() => {
      scroller.scrollLeft = 250
      fireEvent.scroll(scroller)
    })
    expect(head("C").hasAttribute("data-pin-last")).toBe(true)
    expect(head("SEL").hasAttribute("data-pin-last")).toBe(false)
    expect(container.querySelector("[data-pins]")).not.toBeNull()
  })

  it("stacks several pins in display order, whatever the pin order", () => {
    size(1200)
    mount(client({ order: ["a", "b", "c"], hidden: [], pinned: ["c", "a"] }))
    expect(headers()).toEqual(["SEL", "A", "B", "C"])
    expect(head("A").style.left).toBe("100px")
    expect(head("C").style.left).toBe("200px")
  })

  it("loads a layout saved before pins exactly as before", () => {
    size(1200)
    const { container } = mount(
      client({ order: ["c", "a", "b"], hidden: ["b"] })
    )
    expect(headers()).toEqual(["SEL", "C", "A"])
    expect(container.querySelector("[data-pinned]")).toBeNull()
    expect(container.querySelector("[data-pins]")).toBeNull()
  })

  it("un-sticks the pins past 60% of the frame", () => {
    // cap 384: the tick, A and B (300) stick; C would make 400, so it scrolls.
    size(640)
    mount(
      client({ order: ["a", "b", "c"], hidden: [], pinned: ["a", "b", "c"] })
    )
    expect(headers()).toEqual(["SEL", "A", "B", "C"])
    expect(head("B").hasAttribute("data-pinned")).toBe(true)
    expect(head("C").hasAttribute("data-pinned")).toBe(false)
  })

  it("ignores pins in a narrow frame", () => {
    size(500)
    const { container } = mount(
      client({ order: ["a", "b", "c"], hidden: [], pinned: ["c"] })
    )
    expect(headers()).toEqual(["SEL", "A", "B", "C"])
    expect(container.querySelector("[data-pinned]")).toBeNull()
  })

  it("does not pin a hidden column", () => {
    size(1200)
    const { container } = mount(
      client({ order: ["a", "b", "c"], hidden: ["c"], pinned: ["c"] })
    )
    expect(headers()).toEqual(["SEL", "A", "B"])
    expect(container.querySelector("[data-pinned]")).toBeNull()
  })
})

describe("pins persist with the layout", () => {
  it("saves pins with order + hidden, and keeps them on a later write", async () => {
    vi.useFakeTimers()
    try {
      const { useTablePreference } = await import("@/lib/use-table-preference")
      const qc = client({ order: ["a", "b"], hidden: ["b"] })
      let pref: ReturnType<typeof useTablePreference> | null = null
      function Probe() {
        pref = useTablePreference("t")
        return null
      }
      render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>
      )
      expect(pref!.pinned).toEqual([])
      act(() => pref!.setLayout({ pinned: ["a"] }))
      act(() => {
        vi.advanceTimersByTime(400)
      })
      const body = (n: number) =>
        JSON.parse(
          (vi.mocked(api).mock.calls[n][1] as RequestInit).body as string
        )
      expect(body(0)).toEqual({
        order: ["a", "b"],
        hidden: ["b"],
        pinned: ["a"],
      })
      expect(pref!.pinned).toEqual(["a"])
      // A visibility write leaves the pins as they are.
      act(() => pref!.setLayout({ order: ["b", "a"], hidden: [] }))
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(body(1)).toEqual({ order: ["b", "a"], hidden: [], pinned: ["a"] })
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes no pins key for a layout that never had any", async () => {
    vi.useFakeTimers()
    try {
      const { useTablePreference } = await import("@/lib/use-table-preference")
      const qc = client({ order: ["a"], hidden: [] })
      let pref: ReturnType<typeof useTablePreference> | null = null
      function Probe() {
        pref = useTablePreference("t")
        return null
      }
      render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>
      )
      act(() => pref!.setLayout({ hidden: ["a"] }))
      act(() => {
        vi.advanceTimersByTime(400)
      })
      const sent = JSON.parse(
        (vi.mocked(api).mock.calls[0][1] as RequestInit).body as string
      )
      expect(sent).toEqual({ order: ["a"], hidden: ["a"] })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the preset behind a table's default", () => {
  it("is read from the prefs payload, and kept across a save", async () => {
    vi.useFakeTimers()
    try {
      const { useTablePreference } = await import("@/lib/use-table-preference")
      const qc = new QueryClient()
      qc.setQueryData<ColumnPref>(["col-pref", "t"], {
        source: "preset",
        is_forced: false,
        data: { order: ["a"], hidden: [] },
        preset: { id: "p1", name: "NOC view" },
      })
      let pref: ReturnType<typeof useTablePreference> | null = null
      function Probe() {
        pref = useTablePreference("t")
        return null
      }
      render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>
      )
      expect(pref!.presetName).toBe("NOC view")
      expect(pref!.hasUserRow).toBe(false)
      act(() => pref!.setLayout({ hidden: ["a"] }))
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(pref!.hasUserRow).toBe(true)
      expect(pref!.presetName).toBe("NOC view")
    } finally {
      vi.useRealTimers()
    }
  })
})
