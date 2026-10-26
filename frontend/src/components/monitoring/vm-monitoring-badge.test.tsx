// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { VmMonitoringBadge } from "./device-monitoring"

// The VM header's monitoring pill: the VM list's roll-up for one VM.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <VmMonitoringBadge vmId="vm1" />
    </QueryClientProvider>
  )
}

describe("VmMonitoringBadge", () => {
  beforeEach(() => apiMock.mockReset())
  afterEach(cleanup)

  it("asks the bulk roll-up for the VM and shows its pill", async () => {
    apiMock.mockResolvedValue({
      statuses: {
        vm1: {
          status: "down",
          counts: { down: 1 },
          monitored_ips: 1,
          external: { system: "prtg", host: "vm1", hostid: "1", url: "" },
        },
      },
    })
    mount()
    await waitFor(() =>
      expect(screen.getByTestId("vm-monitoring-badge")).toBeTruthy()
    )
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/monitoring/status/")
    expect(JSON.parse(String(init?.body))).toEqual({ vms: ["vm1"] })
    expect(screen.getByTestId("vm-monitoring-badge").textContent).toMatch(
      /down/i
    )
    // The shared hover, never a browser title.
    expect(
      screen.getByTestId("vm-monitoring-badge").closest("[title]")
    ).toBeNull()
  })

  it("renders nothing for a VM with no monitored addresses", async () => {
    apiMock.mockResolvedValue({ statuses: {} })
    const { container } = mount()
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(container.textContent).toBe("")
  })
})
