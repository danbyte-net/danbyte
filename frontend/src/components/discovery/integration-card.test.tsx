// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { DiscoverySettings, DiscoveryStatus } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DiscoveryCardBody } from "./integration-card"

// The Discovery card (#451): the deployment switch in its three states and
// the transport switches, most secure first.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))

function status(
  over: Partial<DiscoveryStatus["deployment"]> = {}
): DiscoveryStatus {
  const deployment = {
    enabled: false,
    source: "setting" as const,
    changed_by: "",
    changed_at: null,
    can_change: true,
    ...over,
  }
  return {
    deployment_enabled: deployment.enabled,
    deployment,
    enabled: true,
    active: deployment.enabled,
    can_manage: true,
    first_use_keys_allowed: true,
  }
}

const SETTINGS: DiscoverySettings = {
  deny_subnets: [],
  transports: { ssh_key: true, ssh_password: true, winrm: false },
  winrm: { available: true, label: "", reason: "" },
  can_change: true,
  updated_at: "2026-11-11T00:00:00Z",
}

function wrap(s: DiscoveryStatus) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DiscoveryCardBody status={s} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const sw = (name: string) => screen.getByRole("switch", { name })

beforeEach(() => apiMock.mockReset())
afterEach(cleanup)

describe("the deployment switch", () => {
  it("is a switch for a deployment admin when the env is unset", async () => {
    apiMock.mockResolvedValue(status({ enabled: true }))
    wrap(status())
    const s = sw("This deployment")
    expect(s.hasAttribute("disabled")).toBe(false)
    fireEvent.click(s)
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/discovery/deployment/",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: true }),
        })
      )
    )
  })

  it("is disabled for a tenant admin", () => {
    wrap(status({ can_change: false }))
    expect(sw("This deployment").hasAttribute("disabled")).toBe(true)
  })

  it("shows locked off and locked on", () => {
    const { unmount } = wrap(status({ source: "env", can_change: false }))
    expect(screen.getByText("Locked off by the deployment")).toBeTruthy()
    expect(sw("This deployment").hasAttribute("disabled")).toBe(true)
    unmount()
    wrap(status({ source: "env", enabled: true, can_change: false }))
    expect(screen.getByText("Locked on by the deployment")).toBeTruthy()
    expect(sw("This deployment").getAttribute("data-state")).toBe("checked")
  })
})

describe("the transports", () => {
  it("lists them most secure first and saves a switch", async () => {
    apiMock.mockImplementation((_path, init) =>
      Promise.resolve(
        init?.method === "PATCH"
          ? {
              ...SETTINGS,
              transports: { ...SETTINGS.transports, ssh_password: false },
            }
          : SETTINGS
      )
    )
    wrap(status({ enabled: true }))
    await waitFor(() => expect(sw("SSH key login")).toBeTruthy())
    const names = screen
      .getAllByRole("switch")
      .map((s) => s.getAttribute("aria-label"))
    expect(names).toEqual([
      "This deployment",
      "SSH key login",
      "SSH password login",
      "WinRM over HTTPS",
    ])
    expect(sw("WinRM over HTTPS").getAttribute("data-state")).toBe("unchecked")
    fireEvent.click(sw("SSH password login"))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/discovery/settings/",
        expect.objectContaining({
          body: JSON.stringify({ transports: { ssh_password: false } }),
        })
      )
    )
  })

  it("cannot switch on WinRM where it is not available", async () => {
    apiMock.mockResolvedValue({
      ...SETTINGS,
      winrm: {
        available: false,
        label: "Forbidden by the deployment",
        reason: "Off for this deployment.",
      },
    })
    wrap(status({ enabled: true }))
    await waitFor(() =>
      expect(screen.getByText("Forbidden by the deployment")).toBeTruthy()
    )
    expect(sw("WinRM over HTTPS").hasAttribute("disabled")).toBe(true)
  })
})
