// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SnmpDriftRow } from "@/lib/api"
import { SnmpDriftStatusBadge } from "./snmp-drift-hover"

// Hovering "N drifted" on the SNMP drift list shows what differs (#419) -
// fetched when the card opens, never per row on render.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params: _p,
    search: _s,
    to: _t,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    params?: unknown
    search?: unknown
    to?: string
  }) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
}))

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({
    drift: [
      {
        kind: "interface_mismatch",
        interface_id: "i1",
        name: "Gi1/0/5",
        field: "mac_address",
        intended: "00:aa:00:00:00:01",
        observed: "00:aa:00:00:00:02",
      },
    ],
  })
})

const row = (over: Partial<SnmpDriftRow>): SnmpDriftRow => ({
  device: "dev-1",
  device_name: "sw1",
  status: "drift",
  reachable: true,
  drift_count: 1,
  by_kind: {
    device_field: 0,
    interface_missing: 0,
    interface_mismatch: 1,
    interface_stale: 0,
  },
  interfaces_drifted: 1,
  profile_name: null,
  polled_at: null,
  ...over,
})

function mount(r: SnmpDriftRow) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SnmpDriftStatusBadge row={r} />
    </QueryClientProvider>
  )
}

describe("SnmpDriftStatusBadge", () => {
  it("fetches nothing until hovered, then lists the differences", async () => {
    mount(row({}))
    expect(screen.getByText("1 drifted")).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()

    fireEvent.pointerEnter(screen.getByText("1 drifted").closest("a")!, {
      pointerType: "mouse",
    })
    expect(await screen.findByText("Gi1/0/5")).toBeTruthy()
    expect(screen.getByText("00:aa:00:00:00:02")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(apiMock.mock.calls[0][0]).toBe(
      "/api/monitoring/devices/dev-1/snmp/drift/"
    )
  })

  it("in-sync and unreachable rows are plain pills", () => {
    mount(row({ status: "in_sync", drift_count: 0 }))
    expect(screen.getByText("In sync")).toBeTruthy()
    cleanup()
    mount(row({ status: "unreachable", drift_count: 0 }))
    expect(screen.getByText("Unreachable")).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
  })
})
