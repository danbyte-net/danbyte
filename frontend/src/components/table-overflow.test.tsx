// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DataTable } from "@/components/data-table"
import { DetailTab } from "@/components/detail-shell"
import { PrefixIpsTable } from "@/components/prefix-ips-table"
import { Tabs } from "@/components/ui/tabs"

// A table wider than its pane must scroll inside its own frame. That only
// works when every flex item between the frame and the page may shrink below
// its content (`min-w-0`): one row-flex item without it grows to the table's
// full width, and the page's overflow-hidden main column clips the right edge
// - Updated, the row actions, the Columns menu - with no scrollbar. The prefix
// IPs tab shipped that way. jsdom does no layout, so these pin the class
// contract that makes the browser do it.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
    humanIds: false,
  }),
  objCan: () => true,
}))

afterEach(cleanup)

let answers: Record<string, unknown> = {}
beforeEach(() => {
  answers = {
    "/api/prefs/columns/": { source: "none", is_forced: false, data: null },
    "/api/custom-fields/": { count: 0, results: [] },
    "/api/ip-ranges/": { count: 0, results: [] },
  }
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k))
    return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
  })
})

function mount(node: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

const cls = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/)

/** Each element between `from` (exclusive) and `to` (inclusive) that is a
 * flex item of a row flexbox yet keeps `min-width: auto` - the ones that grow
 * to the table's width instead of letting its frame scroll. */
function unshrinkableRowItems(from: Element, to: Element): string[] {
  const bad: string[] = []
  for (let el = from.parentElement; el && el !== to; el = el.parentElement) {
    const parent = el.parentElement
    if (!parent) break
    const p = cls(parent)
    const rowFlex =
      (p.includes("flex") || p.includes("inline-flex")) &&
      !p.includes("flex-col")
    if (!rowFlex) continue
    const own = cls(el)
    const ok =
      own.includes("min-w-0") ||
      p.includes("[&>*]:min-w-0") ||
      own.some((c) => /^overflow(-x)?-(auto|hidden|scroll|clip)$/.test(c))
    if (!ok) bad.push(el.getAttribute("class") ?? el.tagName)
  }
  return bad
}

/** Has a background utility, and it isn't an alpha (`bg-x/40`) one. */
const opaqueBg = (el: Element) => {
  const bg = cls(el).filter((c) => c.startsWith("bg-"))
  return bg.length > 0 && bg.every((c) => !c.includes("/"))
}

interface Row {
  id: string
  name: string
}
const COLUMNS: ColumnDef<Row>[] = [
  { id: "name", accessorKey: "name", header: "Name" },
  { id: "actions", header: "", cell: () => <button>Edit</button> },
]

describe("DataTable overflow contract", () => {
  it("scrolls a wide table in its own frame with the row actions pinned", async () => {
    mount(
      <DataTable
        data={[{ id: "1", name: "sw1" }]}
        columns={COLUMNS}
        enableExport
      />
    )
    await screen.findByText("sw1")
    const frame = document.querySelector(
      "[data-slot=table-container]"
    )!.parentElement!
    expect(cls(frame)).toContain("overflow-x-auto")
    // The table's root may shrink when it is itself a row-flex item.
    expect(cls(frame.parentElement!)).toContain("min-w-0")
    // Download / Columns wrap onto a second line instead of running off.
    const bar = screen.getByText("Download").closest("button")!.parentElement!
      .parentElement!
    expect(cls(bar)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]))
    expect(cls(bar)).not.toContain("h-6")
    const actionsTh = screen.getAllByRole("columnheader").at(-1)!
    expect(cls(actionsTh)).toEqual(
      expect.arrayContaining(["sticky", "right-0"])
    )
    // Opaque: the column headers scrolling under it must not show through.
    expect(opaqueBg(actionsTh)).toBe(true)
    const actionsTd = screen.getByText("Edit").closest("td")!
    expect(cls(actionsTd)).toEqual(
      expect.arrayContaining(["sticky", "right-0"])
    )
  })

  it("scrolls a sticky-header table inside its own frame", async () => {
    mount(
      <div className="flex h-96 min-h-0 flex-col">
        <DataTable
          data={[{ id: "1", name: "sw1" }]}
          columns={COLUMNS}
          stickyHeader
        />
      </div>
    )
    await screen.findByText("sw1")
    const container = document.querySelector("[data-slot=table-container]")!
    const frame = container.parentElement!
    // The root fills the bounded pane and the frame may shrink below the
    // table, so the table container - the thead's scroller - scrolls the
    // rows under the header and keeps its sideways scrollbar in view.
    expect(cls(frame.parentElement!)).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1"])
    )
    expect(cls(frame)).toEqual(
      expect.arrayContaining([
        "flex",
        "flex-col",
        "min-h-0",
        "[&>[data-slot=table-container]]:min-h-0",
      ])
    )
    const thead = container.querySelector("thead")!
    expect(cls(thead)).toEqual(expect.arrayContaining(["sticky", "top-0"]))
    expect(opaqueBg(thead)).toBe(true)
  })

  it("lets any pane root in a bare detail tab shrink", async () => {
    mount(
      <Tabs value="t">
        <DetailTab value="t" bare>
          {/* A pane root that forgot min-w-0 - the tab covers for it. */}
          <div className="flex min-h-0 flex-1" data-testid="pane">
            <div className="flex min-w-0 flex-1 flex-col">
              <DataTable data={[{ id: "1", name: "sw1" }]} columns={COLUMNS} />
            </div>
          </div>
        </DetailTab>
      </Tabs>
    )
    await screen.findByText("sw1")
    const tab = document.querySelector("[data-slot=tabs-content]")!
    const frame = document.querySelector("[data-slot=table-container]")!
    expect(unshrinkableRowItems(frame, tab)).toEqual([])
  })

  it("keeps the prefix IPs pane shrinkable down to its table frame", async () => {
    answers["/api/prefixes/p1/ips/"] = {
      count: 1,
      results: [
        {
          id: "ip1",
          ip_address: "10.0.0.5",
          mask_length: 24,
          dhcp: null,
          status: null,
          role: null,
          prefix: "p1",
          scope: "private",
          dns_name: "",
          assigned_device: null,
          assigned_interface: null,
          assigned_vm: null,
          switch: null,
          switch_interface: null,
          description: "",
          reservation_note: "",
          tags: [],
          updated_at: "2026-09-30T10:00:00Z",
        },
      ],
      dhcp_ranges: [],
    }
    const noop = () => undefined
    mount(
      <Tabs value="ips">
        <DetailTab value="ips" bare>
          <PrefixIpsTable
            prefixId="p1"
            showAvailable={false}
            showDhcpPool={false}
            cidr="10.0.0.0/24"
            hasDescendants={false}
            onEdit={noop}
            onDelete={noop}
            onCreateAt={noop}
            onSelectedRowsChange={noop}
            canEdit
            canDelete
            canAdd
          />
        </DetailTab>
      </Tabs>
    )
    expect(await screen.findByText("10.0.0.5")).toBeTruthy()
    const tab = document.querySelector("[data-slot=tabs-content]")!
    const frame = document.querySelector("[data-slot=table-container]")!
    expect(unshrinkableRowItems(frame, tab)).toEqual([])
    // The pane root carries min-w-0 itself too - the range page's Addresses
    // tab mounts it outside a bare tab.
    expect(cls(tab.firstElementChild!)).toContain("min-w-0")
    // Its sticky header needs a pane that bounds the table's height.
    const pane = frame.parentElement!.parentElement!.parentElement!
    expect(cls(pane)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "min-h-0", "flex-1"])
    )
  })
})
