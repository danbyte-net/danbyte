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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AssignedIpsPane } from "./assigned-ips-pane"
import type { AssignedIpsScope } from "./assigned-ips-pane"

// The interface page's IPs tab is the device page's IP table, scoped to one
// interface: the same columns, rows from /api/interfaces/<id>/ips/.

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
    "/api/monitoring/devices/": { ips: [] },
  }
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k))
    return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
  })
})

const IFACE: AssignedIpsScope = {
  kind: "interface",
  deviceId: "d1",
  interfaceId: "if1",
  interfaceName: "eth0",
}

const IP = {
  id: "ip1",
  ip_address: "10.0.0.5",
  mask_length: null,
  dhcp: null,
  status: null,
  role: null,
  prefix: null,
  scope: "private",
  dns_name: "",
  assigned_device: { id: "d1", name: "sw1" },
  assigned_interface: { id: "if1", name: "eth0" },
  assigned_vm: null,
  switch: null,
  switch_interface: null,
  description: "",
  reservation_note: "",
  tags: [],
  is_primary_for_device: true,
  is_secondary_for_device: false,
  is_oob_for_device: false,
  updated_at: "2026-09-30T10:00:00Z",
}

function mount(scope: AssignedIpsScope, canChangeDevice = true) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/interfaces/$id",
    component: () => (
      <AssignedIpsPane
        scope={scope}
        canAddIp
        canAssignIp
        canChangeDevice={canChangeDevice}
      />
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({
      initialEntries: ["/interfaces/if1?tab=ips"],
    }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

function headers() {
  return screen.getAllByRole("columnheader").map((h) => h.textContent)
}

describe("AssignedIpsPane", () => {
  it("lists an interface's IPs as the IP table", async () => {
    answers["/api/interfaces/if1/ips/"] = { count: 1, results: [IP] }
    mount(IFACE)
    expect(await screen.findByText("10.0.0.5")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/interfaces/if1/ips/")
    expect(apiMock).not.toHaveBeenCalledWith("/api/devices/d1/ips/")
    expect(headers()).toEqual(
      expect.arrayContaining([
        "Address",
        "Designation",
        "Status",
        "Monitoring",
        "Role",
      ])
    )
    expect(screen.getByText("★ Primary")).toBeTruthy()
    // Designation and monitoring are the device's.
    expect(apiMock).toHaveBeenCalledWith("/api/monitoring/devices/d1/checks/")
    expect(screen.getByRole("button", { name: "Open actions" })).toBeTruthy()
  })

  it("hides the designation menu without device change", async () => {
    answers["/api/interfaces/if1/ips/"] = { count: 1, results: [IP] }
    mount(IFACE, false)
    expect(await screen.findByText("10.0.0.5")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open actions" })).toBeNull()
  })

  it("shows the empty state when nothing is assigned", async () => {
    answers["/api/interfaces/if1/ips/"] = { count: 0, results: [] }
    mount(IFACE)
    expect(await screen.findByText("No IPs yet.")).toBeTruthy()
    expect(screen.getByText("No IPs assigned to this interface.")).toBeTruthy()
  })

  it("sends Add IP back to the interface tab", async () => {
    answers["/api/interfaces/if1/ips/"] = { count: 0, results: [] }
    mount(IFACE)
    const link = await screen.findByRole("link", { name: "+ Add IP" })
    const href = new URL(link.getAttribute("href") ?? "", "http://x")
    expect(href.pathname).toBe("/ips/new")
    expect(href.searchParams.get("device")).toBe("d1")
    expect(href.searchParams.get("interface")).toBe("if1")
    expect(href.searchParams.get("from")).toBe("/interfaces/if1?tab=ips")
  })

  it("keeps the device scope on its own endpoint and Add IP link", async () => {
    answers["/api/devices/d1/ips/"] = { count: 1, results: [IP] }
    mount({ kind: "device", deviceId: "d1", deviceName: "sw1" })
    expect(await screen.findByText("10.0.0.5")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/devices/d1/ips/")
    const link = screen.getByRole("link", { name: "+ Add IP" })
    const href = new URL(link.getAttribute("href") ?? "", "http://x")
    expect(href.searchParams.get("device")).toBe("d1")
    expect(href.searchParams.has("from")).toBe(false)
  })
})
