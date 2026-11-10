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

import type * as Api from "@/lib/api"
import type { VulnMatch } from "@/lib/api"
import { ExceptionDialog } from "./exception-dialog"

// The Add exception dialog (#451): the scopes the role may create, the
// required fields checked before sending, and the API's field errors on
// their fields.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: async () => ({
    count: 1,
    next: null,
    previous: null,
    results: [{ id: 5, username: "alice", display_name: "Alice" }],
  }),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ canDo: () => true }),
}))
vi.mock("@/lib/datetime", async (orig) => ({
  ...(await orig<object>()),
  useDateFormat: () => ({
    today: "2026-11-10",
    formatDate: (s: string) => s,
    formatDateTime: (s: string) => s,
  }),
}))
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub)

afterEach(cleanup)

const MATCH = {
  id: "m1",
  cve: { vuln_id: "CVE-2023-20198" },
  via: "platform",
  device: { id: "d1", name: "sw-01" },
  virtual_machine: null,
  installed_software: null,
  mapping: {
    id: "map1",
    identifier: "x",
    platform: { id: "p1", name: "IOS-XE" },
  },
} as unknown as VulnMatch

function open(scopes: string[], siteLimited = false) {
  apiMock.mockImplementation(async (path: string) => {
    if (path?.endsWith("/scopes/")) return { scopes, site_limited: siteLimited }
    throw new Error(`unexpected ${path}`)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ExceptionDialog
        open
        onOpenChange={() => {}}
        matches={[MATCH]}
        kind="device"
      />
    </QueryClientProvider>
  )
}

describe("ExceptionDialog", () => {
  beforeEach(() => {
    apiMock.mockReset()
  })

  it("checks reason, owner and a risk acceptance's expiry before sending", async () => {
    open(["device", "virtual_machine", "platform", "application", "tenant"])
    expect(await screen.findAllByText("This device")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Risk accepted" }))
    fireEvent.click(screen.getByRole("button", { name: "Add exception" }))
    expect(await screen.findByText("Say why.")).toBeTruthy()
    expect(screen.getByText("Pick an owner.")).toBeTruthy()
    expect(
      screen.getByText("A risk acceptance needs an expiry date.")
    ).toBeTruthy()
    expect(
      apiMock.mock.calls.every(([p]) => !p || p.endsWith("/scopes/"))
    ).toBe(true)
  })

  it("says why a site-limited role gets the host only", async () => {
    open(["device", "virtual_machine"], true)
    expect(await screen.findAllByText("This device")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("Whole tenant")).toBeNull())
    expect(
      screen.getByRole("button", { name: /info|about|more/i })
    ).toBeTruthy()
  })
})
