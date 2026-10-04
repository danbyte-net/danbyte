// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MonitoringSettingsForm } from "./settings-form"
import type { MonitoringSettings } from "@/lib/api"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
// The ARP-source picker is not under test.
vi.mock("@/components/device-picker", () => ({ DevicePicker: () => null }))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// Radix measures checkboxes with ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const SETTINGS: MonitoringSettings = {
  snmp_import_not_present: false,
  snmp_update_only: false,
  snmp_skip_unrouted_vlans: true,
  snmp_mac_from_fdb: false,
  snmp_default_vrf: null,
  arp_source_devices: [],
  arp_source_devices_detail: [],
  mac_port_display_limit: 4,
  mac_uplink_threshold: 4,
  mac_uplink_lldp: true,
  mac_retention_days: 30,
  global_enabled: true,
  default_interval_seconds: 300,
  stale_after_scans: 0,
  stale_after_days: 0,
  skip_ip_statuses: [],
  skip_ip_status_detail: [],
  dns_sync_enabled: false,
  dns_resolvers: [],
  dns_clear_on_missing: false,
  dns_preserve_if_alive: true,
  renotify_enabled: false,
  renotify_interval_minutes: 60,
  escalate_enabled: false,
  escalate_after_minutes: 60,
  flap_threshold: 5,
  flap_window_minutes: 30,
  availability_frame: "30d",
  auto_clear_flapping: false,
  auto_clear_flapping_after_minutes: 60,
  fast_lane_max_checks: 0,
  group_notifications: false,
  group_threshold: 10,
  discovery_enabled: false,
  discovery_min_prefix_length: 22,
  discovery_interval_minutes: 30,
  discovery_all_prefixes: false,
  cleanup_enabled: false,
  cleanup_after_days: 30,
  engine_offline_after_minutes: 0,
  flap_exclude_ip_statuses: [],
  flap_exclude_ip_status_detail: [],
  default_engine: null,
  outpost_repo_url: "",
  outpost_repo_token_set: false,
  updated_at: "2026-10-03T10:00:00Z",
}

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (path === "/api/monitoring/settings/")
      return Promise.resolve(
        init?.method === "PATCH"
          ? { ...SETTINGS, ...JSON.parse(String(init.body)) }
          : SETTINGS
      )
    return Promise.resolve({ count: 0, results: [] })
  })
})

/** The number input under a NumberField's label. */
function numberField(label: string): HTMLInputElement {
  const input = screen
    .getByText(label)
    .closest("div.space-y-1")
    ?.querySelector("input")
  if (!input) throw new Error(`no input for ${label}`)
  return input
}

describe("MonitoringSettingsForm - MAC tracking", () => {
  it("loads the four settings and saves them back", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <MonitoringSettingsForm />
      </QueryClientProvider>
    )
    expect(await screen.findByText("MAC tracking")).toBeTruthy()
    expect(numberField("MACs shown per port").value).toBe("4")
    expect(numberField("Uplink above").value).toBe("4")
    expect(numberField("Forget MACs unseen for").value).toBe("30")

    fireEvent.change(numberField("MACs shown per port"), {
      target: { value: "0" },
    })
    fireEvent.change(numberField("Uplink above"), { target: { value: "8" } })
    fireEvent.change(numberField("Forget MACs unseen for"), {
      target: { value: "14" },
    })
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /LLDP switch neighbours mark uplinks/,
      })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Save monitoring settings" })
    )

    await vi.waitFor(() =>
      expect(
        apiMock.mock.calls.some(([, init]) => init?.method === "PATCH")
      ).toBe(true)
    )
    const [, init] = apiMock.mock.calls.find(([, i]) => i?.method === "PATCH")!
    expect(JSON.parse(String(init?.body))).toMatchObject({
      mac_port_display_limit: 0,
      mac_uplink_threshold: 8,
      mac_uplink_lldp: false,
      mac_retention_days: 14,
    })
  })
})
