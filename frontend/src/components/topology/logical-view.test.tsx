// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  LogicalBar,
  LogicalDisplay,
  LogicalFilters,
  LogicalTopologyView,
} from "./logical-view"

import type { LogicalTopology } from "@/lib/api"

const { apiMock, copyMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  copyMock: vi.fn<(value: string, done?: string) => Promise<boolean>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("@/lib/clipboard", () => ({ copyWithToast: copyMock }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
// cmdk scrolls the active option into view; jsdom has no layout.
Element.prototype.scrollIntoView = () => undefined

afterEach(cleanup)

const EMPTY: LogicalTopology = { rails: [], nodes: [] }
const ONE_RAIL: LogicalTopology = {
  rails: [
    { id: "v10", vlan_id: 10, name: "Users", color: "#2563eb", group: null },
  ],
  nodes: [
    {
      kind: "device",
      id: "d1",
      name: "sw-01",
      status: "Active",
      sub: null,
      attachments: [
        { rail: "v10", iface: "ge-0/0/1", tagged: false, iface_id: "i1" },
      ],
    },
  ],
}

let logical: LogicalTopology = EMPTY

beforeEach(() => {
  logical = EMPTY
  apiMock.mockReset()
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/sites/"))
      return { count: 1, results: [{ id: "s1", name: "Aarhus" }] }
    if (path.startsWith("/api/vlan-groups/"))
      return { count: 1, results: [{ id: "g1", name: "Campus" }] }
    if (path.startsWith("/api/topology/logical/")) return logical
    throw new Error(`unexpected ${path}`)
  })
  copyMock.mockReset()
  copyMock.mockResolvedValue(true)
})

/** The Logical tab's parts as the topology page places them, on a real
 * in-memory router: they read and write the page's own URL. */
function mount(url = "/topology?tab=logical") {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => (
      <div>
        <LogicalFilters />
        <LogicalDisplay />
        <LogicalBar />
        <LogicalTopologyView />
      </div>
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return router
}

/** The combobox under a popover field's label. */
function comboUnder(label: string) {
  return screen.getByText(label).parentElement!.querySelector("button")!
}

const logicalCalls = () =>
  apiMock.mock.calls
    .map(([p]) => p)
    .filter((p) => p.startsWith("/api/topology/logical/"))

describe("Logical tab controls", () => {
  it("puts Site and VLAN group in a Filters popover with Any rows", async () => {
    mount()
    const trigger = await screen.findByRole("button", { name: "Filters" })
    expect(trigger.className).toContain("h-7")
    expect(trigger.querySelector("svg.lucide-chevron-down")).not.toBeNull()
    fireEvent.click(trigger)
    expect(await screen.findByText("Site")).toBeTruthy()
    expect(screen.getByText("VLAN group")).toBeTruthy()
    // Each combobox shows its Any row while nothing is picked.
    expect(comboUnder("Site").textContent).toContain("Any site")
    expect(comboUnder("VLAN group").textContent).toContain("Any VLAN group")
    expect(screen.queryByText(/All sites|All VLAN groups/)).toBeNull()
  })

  it("counts the filters in force and sends them to the API", async () => {
    mount("/topology?tab=logical&site=s1&vlangroup=g1")
    const trigger = await screen.findByRole("button", { name: /Filters/ })
    expect(trigger.textContent).toContain("2")
    await screen.findByText("No VLAN attachments yet.")
    expect(logicalCalls()).toContain(
      "/api/topology/logical/?site=s1&vlan_group=g1"
    )
  })

  it("puts VMs in a Display popover and writes vms=0 when unticked", async () => {
    const router = mount()
    fireEvent.click(await screen.findByRole("button", { name: "Display" }))
    const vms = await screen.findByRole("checkbox", { name: "VMs" })
    expect(screen.queryByText("Virtual machines")).toBeNull()
    fireEvent.click(vms)
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ vms: "0" })
    )
    await vi.waitFor(() =>
      expect(logicalCalls()).toContain("/api/topology/logical/?include_vms=0")
    )
  })

  it("has a second bar with Copy link", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }))
    expect(copyMock).toHaveBeenCalledWith(window.location.href, "Link copied")
  })
})

describe("LogicalTopologyView", () => {
  it("says so when no VLAN is attached, without a how-to", async () => {
    mount()
    const title = await screen.findByText("No VLAN attachments yet.")
    // EmptyState: the title alone.
    expect(title.nextElementSibling).toBeNull()
  })

  it("labels a rail with one spaced dot", async () => {
    logical = ONE_RAIL
    mount()
    const rail = await screen.findByText("Users · VLAN 10")
    expect(rail.tagName.toLowerCase()).toBe("text")
    expect(screen.getByText("sw-01")).toBeTruthy()
  })

  it("shows the shared loader while it fetches", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/topology/logical/"))
        return new Promise(() => undefined)
      return { count: 0, results: [] }
    })
    mount()
    const status = await screen.findByRole("status")
    expect(status.textContent).toBe("Loading…")
  })
})
