// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Device } from "@/lib/api"
import { Route as DevicesRoute } from "./devices"
import { Route } from "./devices.$id"

// The device page draws progressively: a click from the list paints the
// header from the cached row while the detail read is in flight, the heavy
// Overview cards hold their place with the loading state, and opening the
// page asks for each thing once - never the tenant-wide compliance pass.

const ID = "042e5d7e-8f58-494d-b3e8-981319087bd1"

const ROW = {
  id: ID,
  numid: 1,
  name: "core-big",
  device_type: {
    id: "dt-1",
    name: "Chassis384",
    manufacturer: "Acme",
    manufacturer_id: "m-1",
    u_height: 8,
    rack_width: "full",
    front_image: null,
    rear_image: null,
    lifecycle_state: "",
  },
  site: { id: "s-1", name: "Site 0", region: null },
  role: {
    id: "r-1",
    name: "Core",
    slug: "core",
    color: "#e11d48",
    icon: "",
  },
  platform: null,
  effective_platform: null,
  rack: null,
  position: null,
  cabinet: null,
  din_rail: null,
  location: null,
  cluster: null,
  virtual_chassis: null,
  vc_position: null,
  config_template: { own: null, resolved: null },
  status: {
    id: "st-1",
    name: "Active",
    slug: "active",
    color: "#10b981",
  },
  serial_number: "BIG1",
  asset_tag: "",
  software_version: "",
  coverage: { status: "none", end: null, contracts: 0 },
  description: "The heavy one",
  comments: "",
  airflow: "",
  effective_airflow: "",
  cooling_method: "",
  effective_cooling_method: "air",
  latitude: null,
  longitude: null,
  primary_ip: null,
  secondary_ip: null,
  oob_ip: null,
  tags: [],
  custom_fields: {},
  prtg_sync: "inherit",
  interface_count: 48,
  ip_count: 4,
  // Detail-only: the list serves them as 0 / null.
  hardware_count: 0,
  routing_count: 0,
  contact_count: 0,
  device_profiles: [],
  permissions: { change: true, delete: true },
} as unknown as Device

const DETAIL = {
  ...ROW,
  contact_count: 1,
  virtual_chassis: {
    id: "vc-1",
    name: "stack-a",
    is_master: true,
    member_count: 2,
  },
} as unknown as Device

const { requests, held } = vi.hoisted(() => ({
  requests: [] as string[],
  held: new Map<string, (body: unknown) => void>(),
}))

/** What the page's other reads answer, where it is not an empty list. */
const ANSWERS: Record<string, unknown> = {
  "/api/monitoring/status/": { statuses: {} },
  "/api/planning/planned-changes/map/": { targets: {} },
  "/api/planning/tasks/overdue/": [],
  "/api/integrations/enabled/": {},
  "/api/device-fields/": {},
  [`/api/monitoring/devices/${ID}/snmp/drift/`]: { drift: [] },
  [`/api/monitoring/devices/${ID}/snmp/`]: {
    device: ID,
    data: {},
    interfaces: [],
    neighbors: [],
    arp: [],
  },
  [`/api/devices/${ID}/coverage/`]: {
    status: "none",
    start: null,
    end: null,
    warning_days: 90,
    contracts: [],
    hidden_contracts: 0,
    flags: [],
  },
  [`/api/devices/${ID}/paths/`]: { runs: [] },
  [`/api/devices/${ID}/port-utilization/`]: Object.fromEntries(
    ["interfaces", "virtual", "front_ports", "rear_ports", "combined"].map(
      (k) => [k, { total: 0, connected: 0, reserved: 0, free: 0, marked: 0 }]
    )
  ),
  "/api/monitoring/topology/ghosts/": { nodes: [], edges: [] },
}

/** Paths whose answer the test releases by hand. */
let hold: string[] = []

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  requests.length = 0
  held.clear()
  hold = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      requests.push(url)
      const path = url.split("?")[0]
      if (hold.includes(path))
        return new Promise<Response>((resolve) =>
          held.set(path, (body) => resolve(json(body)))
        )
      if (path === `/api/devices/${ID}/`) return json(DETAIL)
      if (path === "/api/me/")
        return json({
          id: 1,
          username: "root",
          is_superuser: true,
          perms: [],
          permissions: {},
        })
      if (path === `/api/compliance/devices/${ID}/`)
        return json({
          device: { id: ID, name: "core-big" },
          all_clear: false,
          total: 1,
          violations: [
            { rule_id: "r1", rule_name: "Serial set", severity: "warning" },
          ],
        })
      if (path in ANSWERS) return json(ANSWERS[path])
      // The integrations are off.
      if (/^\/api\/(zabbix|prtg)\//.test(path))
        return new Response(JSON.stringify({ detail: "Not enabled." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      return json({ count: 0, next: null, previous: null, results: [] })
    })
  )
  class Stub {
    observe() {}
    unobserve() {}
    disconnect() {}
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  vi.stubGlobal("ResizeObserver", Stub)
  vi.stubGlobal("WebSocket", Stub)
  window.scrollTo = () => undefined
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open(qc: QueryClient) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const devices = DevicesRoute.update({
    id: "/devices",
    path: "/devices",
    getParentRoute: () => root,
  } as never)
  const page = Route.update({
    id: "/$id",
    path: "$id",
    getParentRoute: () => devices,
  } as never)
  const router = createRouter({
    routeTree: root.addChildren([devices.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: [`/devices/${ID}`] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe("device page, opened from the list", () => {
  it("draws the header from the list row while the detail loads", async () => {
    hold = [`/api/devices/${ID}/`]
    const qc = client()
    qc.setQueryData(["devices", ""], { count: 1, results: [ROW] })
    await open(qc)

    // The cached row: name, status and role at once, the detail in flight.
    expect(
      (await screen.findAllByText("core-big", {}, { timeout: 15000 })).length
    ).toBeGreaterThan(0)
    expect(screen.getAllByText("Core").length).toBeGreaterThan(0)
    expect(requests).toContain(`/api/devices/${ID}/`)
    expect(screen.queryByText(/Stack: stack-a/)).toBeNull()

    // The detail lands: what only it carries fills in.
    held.get(`/api/devices/${ID}/`)!(DETAIL)
    expect(await screen.findByText(/Stack: stack-a/)).toBeTruthy()
  }, 30000)
})

describe("device page, opened directly", () => {
  it("holds the heavy cards' places and asks for everything once", async () => {
    hold = [
      `/api/devices/${ID}/interfaces/`,
      `/api/devices/${ID}/port-utilization/`,
    ]
    await open(client())
    await screen.findAllByText("core-big", {}, { timeout: 15000 })

    // The panel and the port figures are known from the device: their cards
    // show the loading state in place instead of popping in later.
    await waitFor(() => {
      expect(screen.getByText("Panel")).toBeTruthy()
      expect(screen.getByText("Port utilization")).toBeTruthy()
    })
    expect(screen.getAllByRole("status").length).toBeGreaterThan(1)

    // The hero's compliance marker reads the device's own status.
    expect(await screen.findByLabelText("1 compliance violation")).toBeTruthy()
    await waitFor(() =>
      expect(requests).toContain(`/api/devices/${ID}/coverage/`)
    )
    expect(requests).not.toContain("/api/compliance/evaluate/")
    const twice = requests.filter((u, i) => requests.indexOf(u) !== i)
    expect(twice).toEqual([])
  }, 30000)
})
