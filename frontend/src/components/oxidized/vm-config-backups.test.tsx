// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DeviceConfigBackups, VmConfigBackups } from "./device-config-backups"

const { apiMock, canDoMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDoMock: vi.fn<(type: string, action: string) => boolean>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo: canDoMock }) }))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const LINK = {
  id: "l1",
  connection: "c1",
  connection_name: "ox",
  full_name: "mikrotik/chr1",
  node_ip: "10.0.0.1",
  node_model: "RouterOS",
  matched_by: "manual",
  last_seen_at: null,
}

function routes(path: string): unknown {
  if (path === "/api/integrations/enabled/") return { oxidized: true }
  if (path.endsWith("/vm1/")) return { links: [LINK] }
  if (path.endsWith("/vm2/")) return { links: [] }
  if (path.includes("/versions/")) return { results: [], history: false }
  if (path.includes("/config/"))
    return { link: LINK, config: "/system identity\n", lines: 1, bytes: 17 }
  throw new Error(`unexpected ${path}`)
}

function renderIt(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => Promise.resolve(routes(path)))
  canDoMock.mockReset()
})
afterEach(cleanup)

describe("config backups on a virtual machine (#384)", () => {
  it("reads the VM endpoints and shows the current config", async () => {
    canDoMock.mockImplementation(
      (type, action) => type === "virtualmachine" && action === "view_config"
    )
    renderIt(<VmConfigBackups vmId="vm1" />)
    expect(await screen.findByText("mikrotik/chr1")).toBeTruthy()
    expect((await screen.findByTestId("config-text")).textContent).toContain(
      "/system identity"
    )
    const paths = apiMock.mock.calls.map(([p]) => p)
    expect(paths).toContain("/api/oxidized/virtual-machines/vm1/")
    expect(paths.some((p) => p.startsWith("/api/oxidized/devices/"))).toBe(
      false
    )
  })

  it("names the VM when no node is linked", async () => {
    canDoMock.mockReturnValue(true)
    renderIt(<VmConfigBackups vmId="vm2" />)
    expect(
      await screen.findByText(
        "No Oxidized node is linked to this virtual machine."
      )
    ).toBeTruthy()
  })

  it("stays hidden without view_config on virtual machines", async () => {
    // view_config on devices does not carry over to VMs.
    canDoMock.mockImplementation(
      (type, action) => type === "device" && action === "view_config"
    )
    const { container } = renderIt(<VmConfigBackups vmId="vm1" />)
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/integrations/enabled/")
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe("")
    expect(
      apiMock.mock.calls.some(([p]) => p.startsWith("/api/oxidized/"))
    ).toBe(false)
  })

  it("keeps the device panel on the device endpoints", async () => {
    canDoMock.mockReturnValue(true)
    apiMock.mockImplementation((path) =>
      Promise.resolve(
        path === "/api/oxidized/devices/d1/" ? { links: [] } : routes(path)
      )
    )
    renderIt(<DeviceConfigBackups deviceId="d1" />)
    expect(
      await screen.findByText("No Oxidized node is linked to this device.")
    ).toBeTruthy()
  })
})
