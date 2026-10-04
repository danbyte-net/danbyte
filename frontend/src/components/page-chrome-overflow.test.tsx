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
import { afterEach, describe, expect, it, vi } from "vitest"

import { DataTable } from "@/components/data-table"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ListPageShell } from "@/components/list-page-shell"
import { buildInterfaceActionColumns } from "@/components/columns/interface-columns"
import type { Interface } from "@/lib/api"

// Page chrome on a narrow window must show every control, not scroll the
// ones that don't fit past an edge with the scrollbar hidden: the list and
// detail headers hid Add / Edit / Delete that way, and the detail tab strip
// hid Journal and Change log. jsdom does no layout, so these pin the class
// contract that makes the browser wrap them instead.

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

apiMock.mockImplementation((path: string) =>
  path.startsWith("/api/prefs/columns/")
    ? Promise.resolve({ source: "none", is_forced: false, data: null })
    : new Promise(() => undefined)
)

afterEach(cleanup)

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

/** A strip that hides what doesn't fit: it scrolls, with the scrollbar off. */
function hidesOverflow(el: Element): boolean {
  const c = cls(el)
  return (
    c.some((x) => /^overflow(-x)?-(auto|scroll|hidden)$/.test(x)) ||
    c.includes("[scrollbar-width:none]")
  )
}

describe("page header overflow", () => {
  it("wraps a list page's controls instead of scrolling them away", async () => {
    mount(
      <ListPageShell
        title="Devices"
        count={3}
        search={{ value: "", onChange: () => undefined }}
        actions={<button type="button">Add device</button>}
      >
        <p>body</p>
      </ListPageShell>
    )
    const add = await screen.findByText("Add device")
    const header = add.closest("header")!
    expect(hidesOverflow(header)).toBe(false)
    expect(cls(header)).toEqual(expect.arrayContaining(["flex-wrap"]))
    expect(cls(header)).not.toContain("h-14")
    // The control group wraps its own items when it can't fit one row.
    expect(cls(add.parentElement!)).toContain("flex-wrap")
  })

  it("wraps a detail page's actions and tabs instead of scrolling them away", async () => {
    mount(
      <DetailShell
        backTo="/"
        backLabel="Prefixes"
        title="10.0.0.0/24"
        actions={<button type="button">Delete</button>}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "journal", label: "Journal" },
          { value: "changelog", label: "Change log" },
        ]}
        tab="overview"
        onTabChange={() => undefined}
      >
        <DetailTab value="overview">body</DetailTab>
      </DetailShell>
    )
    const del = await screen.findByText("Delete")
    const header = del.closest("header")!
    expect(hidesOverflow(header)).toBe(false)
    expect(cls(header)).toContain("flex-wrap")
    expect(cls(del.parentElement!)).toContain("flex-wrap")
    // The title truncates rather than pushing the actions out.
    expect(cls(screen.getByText("10.0.0.0/24"))).toContain("truncate")

    const strip = screen.getByText("Change log").closest("nav")!
    expect(hidesOverflow(strip)).toBe(false)
    expect(cls(strip)).toContain("flex-wrap")
  })
})

describe("interface row actions", () => {
  const iface = {
    id: "if1",
    name: "eth0",
    cable: null,
    virtual: false,
    mark_connected: false,
    reservation: null,
  } as unknown as Interface
  const opts = {
    deviceIdFor: () => "d1",
    canAddIp: true,
    canAssignIp: true,
    canEdit: true,
    canChangeCable: true,
    canDeleteCable: true,
    canConnect: true,
    canReserve: true,
    onTrace: () => undefined,
    onAssignIp: () => undefined,
  }

  it("pins only Edit; the port and IP actions scroll with the data", async () => {
    const columns: ColumnDef<Interface>[] = [
      { id: "name", accessorKey: "name", header: "Name" },
      ...buildInterfaceActionColumns<Interface>(opts),
    ]
    mount(<DataTable data={[iface]} columns={columns} embedded />)
    await screen.findByText("eth0")
    const pinned = [...document.querySelectorAll("td")].filter((td) =>
      cls(td).includes("sticky")
    )
    expect(pinned).toHaveLength(1)
    expect(
      [...pinned[0].querySelectorAll("a, button")].map((b) =>
        b.getAttribute("aria-label")
      )
    ).toEqual(["Edit eth0"])
    // Add IP / Assign IP sit in an ordinary cell that scrolls.
    for (const label of ["+ Add IP", "Assign IP"]) {
      expect(cls(screen.getByText(label).closest("td")!)).not.toContain(
        "sticky"
      )
    }
  })

  it("drops the pinned column without edit, and both without any action", () => {
    expect(
      buildInterfaceActionColumns<Interface>({ ...opts, canEdit: false }).map(
        (c) => c.id
      )
    ).toEqual(["port_actions"])
    expect(
      buildInterfaceActionColumns<Interface>({
        ...opts,
        canEdit: false,
        canAddIp: false,
        canAssignIp: false,
      })
    ).toEqual([])
  })
})
