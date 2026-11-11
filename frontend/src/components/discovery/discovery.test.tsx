// @vitest-environment jsdom
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { InventoryProfile, VulnMatch } from "@/lib/api"
import {
  scheduleLabel,
  scopeLabel,
} from "@/components/columns/inventory-columns"
import { VIA_LABELS } from "@/components/columns/vulnerability-match-columns"
import { subjectOf } from "@/components/vulnerabilities/exception-rules"
import { HostStatusBadge, RunStatusBadge } from "./status"
import { OsBuildNote, usePackagesTab } from "./packages-tab"

const { apiMock, canDoMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDoMock: vi.fn<(type: string, action: string) => boolean>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo: canDoMock }) }))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function profile(over: Partial<InventoryProfile> = {}): InventoryProfile {
  return {
    id: "p1",
    numid: 1,
    name: "Linux",
    description: "",
    enabled: true,
    site_ids: [],
    prefix_ids: [],
    device_ids: [],
    virtual_machine_ids: [],
    scope: { sites: [], prefixes: [], devices: [], virtual_machines: [] },
    interval_hours: 24,
    window_start: null,
    window_end: null,
    max_concurrency: 4,
    timeout_seconds: 60,
    authorisation: "",
    authorised: false,
    authorised_by_name: "",
    authorised_at: null,
    shared_credential_id: null,
    shared_credential: null,
    blocked_reason: "",
    last_run_at: null,
    last_run: null,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
    ...over,
  }
}

beforeEach(() => {
  apiMock.mockReset()
  canDoMock.mockReset()
})
afterEach(cleanup)

describe("inventory profile labels", () => {
  it("reads the schedule and the window", () => {
    expect(scheduleLabel(profile({ interval_hours: 0 }))).toBe("Run now only")
    expect(scheduleLabel(profile())).toBe("Every day")
    expect(scheduleLabel(profile({ interval_hours: 6 }))).toBe("Every 6 h")
    expect(
      scheduleLabel(
        profile({
          interval_hours: 48,
          window_start: "22:00:00",
          window_end: "02:00:00",
        })
      )
    ).toBe("Every 2 days, 22:00–02:00")
  })

  it("counts the scope", () => {
    const p = profile({
      scope: {
        sites: [{ id: "s", name: "HQ" }],
        prefixes: [
          { id: "a", name: "10.0.0.0/24" },
          { id: "b", name: "10.1.0.0/24" },
        ],
        devices: [],
        virtual_machines: [{ id: "v", name: "vm" }],
      },
    })
    expect(scopeLabel(p)).toBe("1 site, 2 prefixes, 1 VM")
  })
})

describe("status pills", () => {
  it("renders a run and a host status as a badge", () => {
    render(
      <>
        <RunStatusBadge status="partial" />
        <HostStatusBadge status="host_key_refused" />
      </>
    )
    expect(screen.getByText("Partial").dataset.variant).toBe("warning")
    expect(screen.getByText("Host key not accepted").dataset.variant).toBe(
      "warning"
    )
  })
})

describe("package matches", () => {
  it("say Package and take only host or tenant exceptions", () => {
    expect(VIA_LABELS.package).toBe("Package")
    const m = {
      via: "package",
      device: { id: "d1", name: "web1" },
      virtual_machine: null,
      installed_software: null,
      mapping: null,
    } as unknown as VulnMatch
    expect(subjectOf(m, "host")).toEqual({ scope: "device", id: "d1" })
    expect(subjectOf(m, "subject")).toBeNull()
  })
})

describe("OS-build matches", () => {
  it("say OS build and take only host or tenant exceptions", () => {
    expect(VIA_LABELS.os_build).toBe("OS build")
    const m = {
      via: "os_build",
      device: null,
      virtual_machine: { id: "v1", name: "win1" },
      installed_software: null,
      mapping: null,
      host_package: null,
    } as unknown as VulnMatch
    expect(subjectOf(m, "host")).toEqual({ scope: "virtual_machine", id: "v1" })
    expect(subjectOf(m, "subject")).toBeNull()
  })

  it("shows the open count, or why the build is not matched", () => {
    const { rerender, container } = render(
      <OsBuildNote
        value={{
          product: "Windows Server 2022",
          build: "10.0.20348.2849",
          flag: "",
          open: 3,
        }}
      />
    )
    expect(screen.getByText("3 open OS-build CVEs")).toBeTruthy()
    rerender(
      <OsBuildNote
        value={{
          product: "Windows Server 2022",
          build: "10.0.20348.5870",
          flag: "",
          open: 0,
        }}
      />
    )
    expect(container.textContent).toBe("")
    rerender(
      <OsBuildNote
        value={{ product: "", build: "", flag: "product_unknown", open: 0 }}
      />
    )
    expect(screen.getByText("OS build not matched")).toBeTruthy()
    rerender(<OsBuildNote value={null} />)
    expect(container.textContent).toBe("")
  })
})

describe("the Packages tab", () => {
  it("is hidden while discovery is off", async () => {
    canDoMock.mockReturnValue(true)
    apiMock.mockImplementation((path) =>
      Promise.resolve(
        path === "/api/discovery/status/"
          ? {
              active: false,
              enabled: true,
              deployment_enabled: false,
              can_manage: true,
            }
          : { count: 5, results: [], os: null }
      )
    )
    const { result } = renderHook(() => usePackagesTab("device", "d1"), {
      wrapper,
    })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/discovery/status/")
    )
    expect(result.current.show).toBe(false)
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/devices/d1/packages/?page_size=1"
    )
  })

  it("shows with a count once something was read", async () => {
    canDoMock.mockReturnValue(true)
    apiMock.mockImplementation((path) =>
      Promise.resolve(
        path === "/api/discovery/status/"
          ? {
              active: true,
              enabled: true,
              deployment_enabled: true,
              can_manage: true,
            }
          : { count: 1412, results: [], os: null }
      )
    )
    const { result } = renderHook(
      () => usePackagesTab("virtual_machine", "v1"),
      { wrapper }
    )
    await waitFor(() => expect(result.current.show).toBe(true))
    expect(result.current.count).toBe(1412)
    expect(apiMock).toHaveBeenCalledWith(
      "/api/virtual-machines/v1/packages/?page_size=1"
    )
  })

  it("needs installed-software view", async () => {
    canDoMock.mockImplementation((t) => t !== "installedsoftware")
    apiMock.mockImplementation(() =>
      Promise.resolve({
        active: true,
        enabled: true,
        deployment_enabled: true,
        can_manage: true,
      })
    )
    const { result } = renderHook(() => usePackagesTab("device", "d1"), {
      wrapper,
    })
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(result.current.show).toBe(false)
  })
})
