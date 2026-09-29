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
import { downloadBlob } from "@/lib/table-export"

const { apiMock, copyMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  copyMock: vi.fn<(value: string, done?: string) => Promise<boolean>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("@/lib/clipboard", () => ({ copyWithToast: copyMock }))
vi.mock("@/lib/table-export", () => ({ downloadBlob: vi.fn() }))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}))
const download = vi.mocked(downloadBlob)

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
const ACTIVE = {
  id: "st1",
  name: "Active",
  slug: "active",
  color: "#22c55e",
  text_color: "#000000",
}
const ONE_RAIL: LogicalTopology = {
  rails: [
    {
      id: "v10",
      vlan_id: 10,
      name: "Users",
      color: "#2563eb",
      group: null,
      status: { ...ACTIVE, id: "st2", name: "Reserved", color: "#a855f7" },
    },
  ],
  nodes: [
    {
      kind: "device",
      id: "d1",
      name: "sw-01",
      status: "Active",
      status_mini: ACTIVE,
      role: { id: "r1", name: "Access", color: "#0ea5e9" },
      sub: "Access",
      attachments: [
        { rail: "v10", iface: "ge-0/0/1", tagged: false, iface_id: "i1" },
      ],
    },
    {
      kind: "vm",
      id: "vm1",
      name: "web-01",
      status: null,
      sub: "c1",
      attachments: [
        { rail: "v10", iface: "net0", tagged: true, iface_id: null },
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
    if (path.startsWith("/api/me/"))
      return {
        is_authenticated: true,
        perms: [],
        permissions: {},
        active_tenant: { id: "t1", name: "Acme", slug: "acme" },
      }
    throw new Error(`unexpected ${path}`)
  })
  copyMock.mockReset()
  copyMock.mockResolvedValue(true)
  download.mockClear()
  localStorage.clear()
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

  it("exports nothing while there is no map", async () => {
    mount()
    await screen.findByText("No VLAN attachments yet.")
    const exp = screen.getByRole("button", { name: /Export/ })
    expect(exp.hasAttribute("disabled")).toBe(true)
  })

  it("exports the map it draws, with its legend and title block", async () => {
    logical = ONE_RAIL
    mount("/topology?tab=logical&site=s1")
    await screen.findByText("Users · VLAN 10")
    const exp = screen.getByRole("button", { name: /Export/ })
    await vi.waitFor(() => expect(exp.hasAttribute("disabled")).toBe(false))
    fireEvent.pointerDown(
      exp,
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    )
    fireEvent.click(await screen.findByText("SVG"))
    // The writers load on first use.
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    })
    const [file, mime, body] = download.mock.calls[0]
    expect(file).toMatch(/^logical-topology-\d{4}-\d{2}-\d{2}\.svg$/)
    expect(mime).toBe("image/svg+xml")
    const svg = String(body)
    for (const text of [
      "Users · VLAN 10",
      "sw-01",
      "web-01",
      "Reserved",
      "ge-0/0/1",
      // The legend: the role, the rail and the legs.
      "Access",
      "Untagged",
      "Tagged",
      // The title block: the name and the filters in words.
      "Logical topology",
      "Site Aarhus",
    ])
      expect(svg, text).toContain(text)
    // Colors from the data: the rail, the card's role, the pills.
    for (const hex of ["#2563eb", "#0ea5e9", "#22c55e", "#a855f7"])
      expect(svg, hex).toContain(hex)
  })
})

describe("LogicalTopologyView", () => {
  it("says so when no VLAN is attached, without a how-to", async () => {
    mount()
    const title = await screen.findByText("No VLAN attachments yet.")
    // EmptyState: the title alone.
    expect(title.nextElementSibling).toBeNull()
  })

  it("labels a rail with one spaced dot and links it to its VLAN", async () => {
    logical = ONE_RAIL
    mount()
    const rail = await screen.findByText("Users · VLAN 10")
    expect(rail.closest("a")?.getAttribute("href")).toBe("/vlans/v10")
    expect(screen.getByText("sw-01")).toBeTruthy()
  })

  it("draws the shared rail diagram: role colors, status pills, VMs dashed", async () => {
    logical = ONE_RAIL
    mount()
    const card = await screen.findByRole("link", { name: "sw-01, Active" })
    expect(card.getAttribute("href")).toBe("/devices/d1")
    expect(card.style.backgroundColor).toBe("rgb(14, 165, 233)")
    expect(screen.getByText("Reserved").getAttribute("data-slot")).toBe("badge")
    const vm = screen.getByRole("link", { name: "web-01" })
    expect(vm.getAttribute("href")).toBe("/virtual-machines/vm1")
    expect(vm.querySelector("span[aria-hidden]")!.className).toContain(
      "border-dashed"
    )
    // The interface opens its page; a VM interface has none.
    expect(
      screen.getByRole("link", { name: "ge-0/0/1" }).getAttribute("href")
    ).toBe("/interfaces/i1")
    expect(screen.getByText("net0").closest("a")).toBeNull()
  })

  it("keys the map in a legend panel that folds away", async () => {
    logical = ONE_RAIL
    mount()
    await screen.findByText("Users · VLAN 10")
    for (const t of ["Legend", "Access", "VLAN", "Device", "VM", "Tagged"])
      expect(screen.getByText(t), t).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Hide legend" }))
    expect(screen.getByRole("button", { name: "Legend" })).toBeTruthy()
    expect(screen.queryByText("Untagged")).toBeNull()
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
