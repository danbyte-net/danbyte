// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { EmbeddedSupportContractTable } from "@/components/embedded-support-contract-table"

// The manufacturer's Contracts tab loaded 500 contracts and said nothing of
// the rest, under a tab count naming them all (#439).

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
    humanIds: false,
  }),
  objCan: () => true,
}))

afterEach(() => {
  cleanup()
  apiMock.mockReset()
})

function contract(i: number) {
  return {
    id: `c${i}`,
    numid: i,
    manufacturer: { id: "m1", name: "Cisco" },
    contract_number: `SN-${i}`,
    service_level: "8x5",
    start_date: null,
    end_date: null,
    state: "active",
    reseller: "",
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
}

function serve(loaded: number, total: number) {
  apiMock.mockImplementation((path: string) =>
    path.startsWith("/api/support-contracts/")
      ? Promise.resolve({
          count: total,
          results: Array.from({ length: loaded }, (_, i) => contract(i)),
        })
      : path.startsWith("/api/prefs/columns/")
        ? Promise.resolve({ source: "none", is_forced: false, data: null })
        : new Promise(() => undefined)
  )
}

function mount(node: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

function contractRequests() {
  return apiMock.mock.calls
    .map(([path]) => path)
    .filter((p) => p.startsWith("/api/support-contracts/"))
}

describe("manufacturer Contracts tab", () => {
  it("asks for the API's full page, not 500", async () => {
    serve(3, 3)
    mount(<EmbeddedSupportContractTable manufacturerId="m1" />)
    expect(await screen.findByText("SN-0")).toBeTruthy()
    const requests = contractRequests()
    expect(requests.length).toBeGreaterThan(0)
    for (const path of requests) {
      expect(path).toContain("manufacturer=m1")
      expect(path).not.toContain("page_size")
    }
    expect(screen.queryByText(/Showing the first/)).toBeNull()
  })

  it("says when the server holds more than arrived", async () => {
    serve(2, 520)
    mount(<EmbeddedSupportContractTable manufacturerId="m1" />)
    expect(
      await screen.findByText(
        "Showing the first 2 of 520 - filter or open the full list to see the rest."
      )
    ).toBeTruthy()
  })
})
