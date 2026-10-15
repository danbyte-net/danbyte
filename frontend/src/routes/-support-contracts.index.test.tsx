// @vitest-environment jsdom
import { Suspense } from "react"
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { SupportContract } from "@/lib/api"
import { Route } from "./support-contracts.index"

// A contract's cost is commercial data (#421): the list shows its Cost
// column only to a user with view_cost on support contracts.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { viewCost: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: (_type: string, action: string) =>
      action === "view_cost" ? perms.viewCost : true,
    humanIds: false,
  }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const CONTRACT: SupportContract = {
  id: "k1",
  numid: 1,
  manufacturer: { id: "m1", name: "Cisco" },
  contract_number: "SN-100",
  service_level: "",
  start_date: null,
  end_date: null,
  state: "active",
  reseller: "",
  cost: 1200,
  currency: "EUR",
  portal_url: "",
  renewal_notes: "",
  description: "",
  notify_channels: [],
  device_count: 0,
  tags: [],
  custom_fields: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}

afterEach(cleanup)
beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
beforeEach(() => {
  perms.viewCost = true
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    Promise.resolve(
      path.startsWith("/api/support-contracts/")
        ? { count: 1, results: [CONTRACT] }
        : {}
    )
  )
})

function mount() {
  const Page = Route.options.component as React.ComponentType
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </QueryClientProvider>
  )
}

describe("support contract list cost", () => {
  it("shows the Cost column with view_cost", async () => {
    mount()
    await screen.findByText("SN-100")
    expect(screen.getByRole("columnheader", { name: /Cost/ })).toBeTruthy()
  })

  it("has no Cost column without view_cost", async () => {
    perms.viewCost = false
    mount()
    await screen.findByText("SN-100")
    expect(screen.queryByRole("columnheader", { name: /Cost/ })).toBeNull()
  })
})
