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
  Cabinet,
  Device,
  DeviceTypeMini,
  DinRail,
  FloorPlanLiveState,
  FloorPlanTile,
} from "@/lib/api"
import { CabinetPanel, plateOrder } from "./cabinet-panel"

// What a cabinet tile opens: a panel over the plan with the cabinet's
// facts, its plate drawn read-only with the devices on it, and the devices
// listed, each a link and a way into its paths.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))

const R1: DinRail = {
  id: "r1",
  label: "R1",
  profile: "ts35",
  x_mm: 10,
  y_mm: 75,
  length_mm: 480,
}
const R2: DinRail = { ...R1, id: "r2", label: "R2", y_mm: 300 }

const CABINET = {
  id: "c1",
  numid: 7,
  name: "Test cabinet",
  facility_id: "=UH1+K1",
  site: { id: "s1", name: "København HQ" },
  location: { id: "l1", name: "Serverrum A" },
  role: { id: "cr1", name: "Control", color: "#8b5cf6" },
  cabinet_type: null,
  status: { id: "st1", name: "Active", color: "#22c55e" },
  rails: [R1, R2],
  description: "",
  document_count: 0,
  device_count: 3,
  tags: [],
  custom_fields: {},
  inner_width_mm: 500,
  inner_height_mm: 600,
  outer_width_mm: 550,
  outer_height_mm: 650,
  outer_depth_mm: 200,
  created_at: "",
  updated_at: "",
} as unknown as Cabinet

const type: DeviceTypeMini = {
  id: "t1",
  name: "PLC",
  manufacturer: null,
  manufacturer_id: null,
  u_height: 0,
  rack_width: "full",
  is_full_depth: false,
  width_mm: 60,
  height_mm: 100,
  din_profiles: ["ts35"],
  din_rail_mm: null,
  front_image: null,
  rear_image: null,
}

const device = (
  id: string,
  rail: DinRail | null,
  offset: number | null
): Device =>
  ({
    id,
    name: id,
    device_type: type,
    role: { id: "dr1", name: "PLC", color: "#0ea5e9" },
    din_rail: rail
      ? { id: rail.id, label: rail.label, profile: rail.profile }
      : null,
    din_offset_mm: offset,
    cabinet: { id: "c1", name: "Test cabinet" },
  }) as Device

const DEVICES = [
  device("io-2", R2, 0),
  device("loose", null, null),
  device("plc-1", R1, 0),
  device("io-1", R1, 80),
]

const TILE = {
  id: "t1",
  x: 2,
  y: 2,
  width: 1,
  height: 1,
  orientation: 0,
  label: "",
  link_kind: "cabinet",
  linked: {
    kind: "cabinet",
    id: "c1",
    name: "Test cabinet",
    route: "/cabinets/c1",
  },
} as FloorPlanTile

const LIVE: FloorPlanLiveState["tiles"][string] = {
  kind: "cabinet",
  device_count: 4,
  rail_count: 2,
  check: "down",
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

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/cabinets/c1/") return Promise.resolve(CABINET)
    if (path.startsWith("/api/devices/?cabinet=c1"))
      return Promise.resolve({ count: DEVICES.length, results: DEVICES })
    return new Promise(() => undefined)
  })
})
afterEach(cleanup)

function mount(tile: FloorPlanTile = TILE) {
  const onClose = vi.fn()
  const onTraceDevice = vi.fn()
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/floorplans/$id",
    component: () => (
      <div className="relative h-[40rem]">
        <CabinetPanel
          tile={tile}
          live={LIVE}
          onClose={onClose}
          onTraceDevice={onTraceDevice}
        />
      </div>
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/floorplans/p1"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return { onClose, onTraceDevice }
}

/** The panel's key/value rows, by label. */
async function rows() {
  const panel = await screen.findByRole("complementary", { name: "Cabinet" })
  await within(panel).findByText("Rails")
  const out: Record<string, string> = {}
  for (const row of panel.querySelectorAll("div.flex.items-baseline")) {
    const [label, value] = [...row.children].map((c) => c.textContent)
    out[label] = value
  }
  return out
}

describe("CabinetPanel", () => {
  it("names the cabinet and gives its facts, live counts first", async () => {
    mount()
    const r = await rows()
    expect(r.Status).toBe("Active")
    expect(r.Role).toBe("Control")
    expect(r.Monitoring.toLowerCase()).toContain("down")
    // The polled state wins over the cabinet's own count.
    expect(r.Devices).toBe("4")
    expect(r.Rails).toBe("2")
    expect(r.Size).toBe("550×650×200 mm")
    expect(r["Facility ID"]).toBe("=UH1+K1")
    expect(screen.getByText("Test cabinet")).toBeTruthy()
  })

  it("draws the plate read-only, with its devices on their rails", async () => {
    mount()
    const plate = await screen.findByRole("group", {
      name: "Plate 500×600 mm, 2 rails",
    })
    await within(plate).findByText("plc-1")
    const bodies = plate.querySelectorAll("[data-device]")
    // Off a rail has no place on the plate.
    expect(
      [...bodies].map((b) => b.getAttribute("data-device")).sort()
    ).toEqual(["io-1", "io-2", "plc-1"])
    for (const b of bodies) {
      expect(b.getAttribute("role")).toBeNull()
      expect(b.getAttribute("class")).toContain("pointer-events-none")
    }
  })

  it("lists the devices rail by rail, each a link", async () => {
    mount()
    const list = (
      await screen.findByRole("region", { name: "Devices" })
    ).querySelector("ul")!
    await within(list).findByText("plc-1")
    const items = within(list).getAllByRole("listitem")
    expect(items.map((li) => within(li).getByRole("link").textContent)).toEqual(
      ["plc-1", "io-1", "io-2", "loose"]
    )
    expect(within(items[0]).getByRole("link").getAttribute("href")).toBe(
      "/devices/plc-1"
    )
    expect(items[0].textContent).toContain("R1")
    expect(items[3].textContent).toContain("-")
  })

  it("traces a device and closes", async () => {
    const { onClose, onTraceDevice } = mount()
    fireEvent.click(await screen.findByRole("button", { name: "Trace io-2" }))
    expect(onTraceDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: "io-2" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("opens the cabinet's page", async () => {
    mount()
    const open = await screen.findByRole("link", { name: "Open cabinet" })
    expect(open.getAttribute("href")).toBe("/cabinets/c1")
  })

  it("titles a labelled tile by its label", async () => {
    mount({ ...TILE, label: "North box" })
    expect(await screen.findByText("North box")).toBeTruthy()
  })
})

describe("plateOrder", () => {
  it("reads rail by rail, left to right, the loose ones last", () => {
    expect(plateOrder(DEVICES, CABINET).map((d) => d.id)).toEqual([
      "plc-1",
      "io-1",
      "io-2",
      "loose",
    ])
  })
})
