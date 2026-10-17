// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SnmpBulkStart, SnmpDriftRow } from "@/lib/api"
import { SnmpDriftBulkBar, bulkSummary } from "./snmp-drift-bulk"

// Bulk Poll / Refresh MACs / Sync on the SNMP drift page (#419): one request
// per action, reads go straight away, Sync asks first and names the devices,
// and the closing toast says what happened.

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: {
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("sonner", () => ({ toast: toastMock }))

afterEach(cleanup)

const row = (name: string): SnmpDriftRow => ({
  device: `id-${name}`,
  device_name: name,
  status: "drift",
  reachable: true,
  drift_count: 2,
  by_kind: {
    device_field: 0,
    interface_missing: 1,
    interface_mismatch: 1,
    interface_stale: 0,
  },
  interfaces_drifted: 2,
  profile_name: "p",
  polled_at: null,
})

const start = (over: Partial<SnmpBulkStart> = {}): SnmpBulkStart => ({
  run_id: "r1",
  action: "poll",
  requested: 2,
  queued: 2,
  skipped: 0,
  outposts: [],
  ...over,
})

let posts: { path: string; body: unknown }[] = []
beforeEach(() => {
  posts = []
  apiMock.mockReset()
  for (const fn of Object.values(toastMock)) fn.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      posts.push({ path, body })
      const action = path.includes("sync")
        ? "sync"
        : path.includes("mac")
          ? "macs"
          : "poll"
      return Promise.resolve(start({ action, queued: body.devices.length }))
    }
    return Promise.resolve({
      run_id: "r1",
      found: true,
      done: true,
      total: 2,
      processed: 2,
      counts: {
        ok: 2,
        unreachable: 0,
        failed: 0,
        denied: 0,
        busy: 0,
        outpost: 0,
      },
    })
  })
})

function mount(selected = [row("sw1"), row("sw2")], onCleared = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SnmpDriftBulkBar selected={selected} onCleared={onCleared} />
    </QueryClientProvider>
  )
  return onCleared
}

describe("SnmpDriftBulkBar", () => {
  it("renders nothing without a selection", () => {
    mount([])
    expect(screen.queryByText(/selected/)).toBeNull()
  })

  it("polls the selection in one request, without asking", async () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Poll" }))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(posts).toEqual([
      {
        path: "/api/monitoring/snmp-drift/bulk-poll/",
        body: { devices: ["id-sw1", "id-sw2"] },
      },
    ])
    expect(toastMock.success.mock.calls[0][0]).toBe("Polled 2 of 2 devices")
  })

  it("refreshes MACs through its own endpoint", async () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Refresh MACs" }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].path).toBe("/api/monitoring/snmp-drift/bulk-mac-refresh/")
  })

  it("asks before a sync and lists the devices", async () => {
    const onCleared = mount()
    fireEvent.click(screen.getByRole("button", { name: "Sync from SNMP" }))
    expect(await screen.findByText("Sync from SNMP - 2 devices?")).toBeTruthy()
    expect(screen.getByText("sw1")).toBeTruthy()
    expect(screen.getByText("sw2")).toBeTruthy()
    expect(posts).toEqual([])

    const buttons = screen.getAllByRole("button", { name: "Sync from SNMP" })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      path: "/api/monitoring/snmp-drift/bulk-sync/",
      body: { devices: ["id-sw1", "id-sw2"] },
    })
    expect(onCleared).toHaveBeenCalled()
  })

  it("cancelling a sync sends nothing", async () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Sync from SNMP" }))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByText("Sync from SNMP - 2 devices?")).toBeNull()
    )
    expect(posts).toEqual([])
  })
})

describe("bulkSummary", () => {
  const counts = {
    ok: 3,
    unreachable: 1,
    failed: 0,
    denied: 1,
    busy: 1,
    outpost: 0,
  }

  it("names what did not go through", () => {
    const s = bulkSummary({
      start: start({
        queued: 6,
        skipped: 2,
        outposts: [{ name: "branch", devices: 4, stale: true }],
      }),
      run: { run_id: "r1", found: true, done: true, counts },
    })
    expect(s.tone).toBe("warning")
    expect(s.title).toBe("Polled 3 of 6 devices")
    expect(s.detail).toBe(
      "1 unreachable · 1 already being read · 3 not permitted · 4 devices queued on Outpost branch (offline)"
    )
  })

  it("leads a sync with what it changed", () => {
    const s = bulkSummary({
      start: start({ action: "sync", queued: 3 }),
      run: {
        run_id: "r1",
        found: true,
        done: true,
        counts: { ...counts, unreachable: 0, denied: 0, busy: 0 },
        sync: {
          interfaces_created: 4,
          interfaces_updated: 2,
          ips_assigned: 0,
          ips_skipped: 1,
          vlans_assigned: 0,
        },
      },
    })
    expect(s.tone).toBe("success")
    expect(s.title).toBe("Synced 3 of 3 devices")
    expect(s.detail).toBe(
      "4 interfaces added, 2 updated · 1 IPs without a prefix"
    )
  })

  it("an all-Outpost request has no run", () => {
    const s = bulkSummary({
      start: start({
        run_id: null,
        queued: 0,
        outposts: [{ name: "branch", devices: 2, stale: false }],
      }),
      run: null,
    })
    expect(s).toEqual({
      tone: "info",
      title: "Poll queued on 1 Outpost",
      detail: "2 devices queued on Outpost branch",
    })
  })
})
