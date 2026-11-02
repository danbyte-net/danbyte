// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
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

import type {
  FloorPlanCablePanel,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTilePanel,
  FloorPlanTray,
} from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { CableDetailPanel } from "./cable-detail-panel"
import type { CableRoute } from "./cable-draw"
import { ObjectDetailPanel } from "./object-detail-panel"

// The floor plan's detail panels: a cable in full (both ends, a Hidden
// end, the trays it rides, an out-of-date route) and a device or rack tile
// (facts, monitoring, ports, a rack's devices, the cables on the plan).

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))

const STATUS = { id: "s", name: "Active", color: "#22c55e", text_color: "" }
const DEVICE = {
  id: "d1",
  name: "sw1",
  role: { id: "r", name: "Access", color: "#0ea5e9" },
  status: STATUS,
  site: { id: "si", name: "HQ" },
  location: { id: "lo", name: "Hall" },
  rack: { id: "ra", name: "R1" },
  cabinet: null,
  position: 40,
  face: "front",
  u_height: 1,
}

const PANEL: FloorPlanCablePanel = {
  id: "c1",
  numid: 3,
  label: "PATCH-01",
  name: "PATCH-01",
  type: "cat6",
  type_display: "CAT6",
  color: "#2563eb",
  status: STATUS,
  length: 12,
  length_unit: "m",
  length_source: "computed",
  description: "",
  ends: {
    A: [
      {
        device: DEVICE,
        port: {
          kind: "interface",
          id: "i1",
          name: "Gi1/0/1",
          label: "",
          type: "1000base-t",
          type_display: "1000BASE-T",
          description: "to server",
          speed: "1G",
          enabled: true,
          vlan: { id: "v", vlan_id: 20, name: "users", color: "" },
          ip_addresses: [{ id: "ip", ip_address: "10.0.0.5/24" }],
          observed: { oper_status: "up", admin_status: "up", speed_mbps: "" },
        },
      },
    ],
    B: [{ hidden: true }],
  },
}

const PATH: FloorPlanCablePath = {
  id: "c1",
  label: "PATCH-01",
  color: "#2563eb",
  type: "cat6",
  length: 12,
  length_unit: "m",
  length_source: "computed",
  a_tiles: ["t1"],
  b_tiles: ["t2"],
  a_points: [{ device: "d1", port: "Gi1/0/1", device_name: "sw1" }],
  b_points: [{ device: null, port: null, hidden: true }],
  tray_ids: ["tr1"],
}

const TRAYS = [
  { id: "tr1", name: "Overhead A", points: [], cables: [] },
] as unknown as FloorPlanTray[]

const ROUTE: CableRoute = {
  id: "c1",
  points: [
    [0, 0],
    [10, 0],
  ],
  segs: [],
  trayIds: ["tr1"],
  routed: true,
  runCells: 10,
  dropsMm: [0, 0],
  stored: true,
  stale: true,
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

let tilePanel: FloorPlanTilePanel
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/floor-plans/p1/cable-panel/c1/")
      return Promise.resolve(PANEL)
    if (path.startsWith("/api/floor-plans/p1/tile-panel/"))
      return Promise.resolve(tilePanel)
    // The trace: a two-ended run has no multi-hop path to list.
    return new Promise(() => undefined)
  })
})
afterEach(cleanup)

function mount(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/$id",
    component: () => <div className="relative h-[40rem]">{node}</div>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/floorplans/p1"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("CableDetailPanel", () => {
  const props = () => ({
    onClose: vi.fn(),
    onShowTile: vi.fn(),
    onHighlightTray: vi.fn(),
  })

  it("shows the cable, its route and both ends", async () => {
    const p = props()
    mount(
      <CableDetailPanel
        planId="p1"
        cableId="c1"
        cablePath={PATH}
        route={ROUTE}
        trays={TRAYS}
        cellMm={600}
        {...p}
      />
    )
    const panel = await screen.findByRole("complementary", { name: "Cable" })
    await within(panel).findByText("CAT6")
    expect(within(panel).getAllByText("Active").length).toBeGreaterThan(0)
    expect(within(panel).getByText("#2563eb")).toBeTruthy()
    // Route: documented but out of date, riding one tray.
    expect(within(panel).getByText("Out of date")).toBeTruthy()
    expect(within(panel).getByText("Documented")).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Overhead A" }))
    expect(p.onHighlightTray).toHaveBeenCalledWith("tr1")

    const a = panel.querySelector("[data-cable-end=A]") as HTMLElement
    expect(within(a).getByRole("link", { name: "sw1" })).toBeTruthy()
    expect(within(a).getByText("Access")).toBeTruthy()
    expect(within(a).getByText("HQ · Hall · R1 · U40")).toBeTruthy()
    expect(within(a).getByText("Gi1/0/1")).toBeTruthy()
    expect(within(a).getByText("1G")).toBeTruthy()
    expect(within(a).getByText("Up")).toBeTruthy()
    expect(within(a).getByText("20 · users")).toBeTruthy()
    expect(within(a).getByText("10.0.0.5/24")).toBeTruthy()
    fireEvent.click(within(a).getByRole("button", { name: /Show on plan/ }))
    expect(p.onShowTile).toHaveBeenCalledWith("t1")

    // The far end the reader may not view reads Hidden, nothing more.
    const b = panel.querySelector("[data-cable-end=B]") as HTMLElement
    expect(b.textContent).toBe("Hidden")
  })

  it("closes", async () => {
    const p = props()
    mount(
      <CableDetailPanel
        planId="p1"
        cableId="c1"
        cablePath={PATH}
        trays={TRAYS}
        cellMm={600}
        {...p}
      />
    )
    const panel = await screen.findByRole("complementary", { name: "Cable" })
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }))
    expect(p.onClose).toHaveBeenCalled()
  })
})

const DEVICE_TILE = {
  id: "t1",
  label: "",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  linked: { kind: "device", id: "d1", name: "sw1" },
} as FloorPlanTile

describe("ObjectDetailPanel", () => {
  it("shows a device's facts, monitoring, ports and cables", async () => {
    tilePanel = {
      kind: "device",
      device: {
        ...DEVICE,
        numid: 1,
        device_type: { id: "dt", model: "C9300-48P", manufacturer: "Cisco" },
        platform: { id: "pl", name: "IOS-XE" },
        serial_number: "FOC123",
        asset_tag: "",
        primary_ip: { id: "ip", ip_address: "10.0.0.2/24", dns_name: "" },
        secondary_ip: null,
        oob_ip: null,
        tenant: { id: "te", name: "Demo" },
        description: "",
        software_version: "",
        tags: [{ id: 1, name: "core", color: "" }],
        profiles: [],
      },
      monitoring: {
        status: "down",
        counts: { down: 1 },
        checks: [
          {
            id: "k1",
            name: "Ping",
            kind: "icmp",
            status: "down",
            ip: "10.0.0.2",
            last_checked: null,
            since: null,
            latency_ms: null,
          },
        ],
      },
      ports: {
        total: 48,
        connected: 12,
        free: 36,
        disabled: 0,
        observed: true,
        up: 10,
        down: 2,
      },
    }
    const onPickCable = vi.fn()
    mount(
      <ObjectDetailPanel
        planId="p1"
        tile={DEVICE_TILE}
        cablePaths={[PATH]}
        onClose={vi.fn()}
        onPickCable={onPickCable}
      />
    )
    const panel = await screen.findByRole("complementary", { name: "Device" })
    await within(panel).findByText("Cisco C9300-48P")
    expect(within(panel).getByText("FOC123")).toBeTruthy()
    expect(within(panel).getByText("10.0.0.2/24")).toBeTruthy()
    expect(within(panel).getByText("IOS-XE")).toBeTruthy()
    expect(within(panel).getByText("core")).toBeTruthy()
    expect(within(panel).getByText("Ping")).toBeTruthy()
    expect(within(panel).getByText("12 / 48")).toBeTruthy()
    expect(within(panel).getByText("10 up")).toBeTruthy()
    expect(within(panel).getByText("2 down")).toBeTruthy()
    expect(
      within(panel).getByRole("link", { name: /Open device/ })
    ).toBeTruthy()
    // The plan's cable on it opens the cable panel.
    fireEvent.click(within(panel).getByText("PATCH-01"))
    expect(onPickCable).toHaveBeenCalledWith("c1")
  })

  it("lists a rack's devices by U", async () => {
    tilePanel = {
      kind: "rack",
      rack: {
        id: "ra",
        name: "R1",
        facility_id: "",
        role: null,
        status: STATUS,
        site: { id: "si", name: "HQ" },
        location: null,
        rack_type: null,
        u_height: 42,
        tenant: null,
        tags: [],
      },
      monitoring: { status: null },
      devices: [
        {
          id: "d1",
          name: "sw1",
          role: null,
          status: STATUS,
          position: 40,
          face: "front",
          u_height: 1,
          device_type: "C9300",
          check: null,
        },
      ],
      used_units: 1,
      hidden_count: 2,
    }
    mount(
      <ObjectDetailPanel
        planId="p1"
        tile={{
          ...DEVICE_TILE,
          linked: { kind: "rack", id: "ra", name: "R1" },
        }}
        cablePaths={[]}
        onClose={vi.fn()}
        onPickCable={vi.fn()}
      />
    )
    const panel = await screen.findByRole("complementary", { name: "Rack" })
    await within(panel).findByText("U40")
    expect(within(panel).getByRole("link", { name: "sw1" })).toBeTruthy()
    expect(within(panel).getByText("1 / 42U")).toBeTruthy()
    expect(within(panel).getByText("2 hidden devices")).toBeTruthy()
  })

  it("names nothing of a hidden object", async () => {
    tilePanel = { kind: "device", hidden: true }
    mount(
      <ObjectDetailPanel
        planId="p1"
        tile={{
          ...DEVICE_TILE,
          linked: { kind: "device", id: null, name: "Hidden", hidden: true },
        }}
        cablePaths={[PATH]}
        onClose={vi.fn()}
        onPickCable={vi.fn()}
      />
    )
    const panel = await screen.findByRole("complementary", { name: "Device" })
    await within(panel).findAllByText("Hidden")
    expect(within(panel).queryByText("PATCH-01")).toBeNull()
  })
})
