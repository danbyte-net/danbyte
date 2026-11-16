// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { TooltipProvider } from "@/components/ui/tooltip"
import { useDiscoveryTab } from "./discovery-tab"

// Discovery inside Monitoring (#451): the tab shows only while Discovery is
// on and you may view its profiles, and its settings are one section of the
// monitoring settings - not the integration card.

const { apiMock, canDoMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDoMock: vi.fn<(type: string, action: string) => boolean>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ canDo: canDoMock, canManage: true }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
}

const STATUS = {
  deployment_enabled: true,
  deployment: {
    enabled: true,
    source: "setting",
    changed_by: "",
    changed_at: null,
    can_change: true,
  },
  enabled: true,
  active: true,
  can_manage: true,
  first_use_keys_allowed: true,
}

const DISCOVERY_SETTINGS = {
  deny_subnets: ["10.9.0.0/16"],
  transports: { ssh_key: true, ssh_password: true, winrm: false },
  winrm: { available: true, label: "", reason: "" },
  nmap: {
    available: true,
    enabled: false,
    path: "/usr/bin/nmap",
    version: "7.98",
    label: "nmap 7.98 at /usr/bin/nmap",
    reason: "",
  },
  can_change: true,
  updated_at: "2026-11-11T00:00:00Z",
}

function serve(status: object) {
  apiMock.mockImplementation((path) => {
    if (path === "/api/discovery/status/") return Promise.resolve(status)
    if (path === "/api/discovery/settings/")
      return Promise.resolve(DISCOVERY_SETTINGS)
    if (path === "/api/monitoring/settings/") return Promise.resolve(null)
    return Promise.resolve({ count: 0, results: [] })
  })
}

beforeEach(() => {
  apiMock.mockReset()
  canDoMock.mockReset()
})
afterEach(cleanup)

describe("the Discovery tab", () => {
  it("shows while Discovery is on and you may view profiles", async () => {
    canDoMock.mockReturnValue(true)
    serve(STATUS)
    const { result } = renderHook(() => useDiscoveryTab(), { wrapper })
    await waitFor(() => expect(result.current).toBe(true))
    expect(canDoMock).toHaveBeenCalledWith("inventoryprofile", "view")
  })

  it("hides while Discovery is off", async () => {
    canDoMock.mockReturnValue(true)
    serve({ ...STATUS, active: false, deployment_enabled: false })
    const { result } = renderHook(() => useDiscoveryTab(), { wrapper })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/discovery/status/")
    )
    expect(result.current).toBe(false)
  })

  it("hides without profile view", async () => {
    canDoMock.mockImplementation((t) => t !== "inventoryprofile")
    serve(STATUS)
    const { result } = renderHook(() => useDiscoveryTab(), { wrapper })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/discovery/status/")
    )
    expect(result.current).toBe(false)
  })
})

describe("the Discovery integration card", () => {
  // One place for the settings: the card is a switch and a link, like the
  // other integration cards.
  it("carries no discovery settings of its own", () => {
    const src = readFileSync(
      join(process.cwd(), "src/routes/settings.integrations.tsx"),
      "utf8"
    )
    expect(src).not.toMatch(/host-discovery-settings|integration-card/)
    expect(src).not.toMatch(/TransportRows|NmapRow|DeploymentRow|deny_subnets/)
  })
})
