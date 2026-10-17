// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SupportCoverageSummary } from "@/lib/api"
import { SupportCoverageWidget } from "./widget-support-coverage"
import type { SupportCoverageConfig } from "./widget-support-coverage"

// The Support coverage widget (#421): counts per status that open the device
// list on that status (and the widget's site / manufacturer), and the
// contracts that end soonest.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ me: {} }) }))

const SUMMARY: SupportCoverageSummary = {
  warning_days: 90,
  total: 10,
  counts: { covered: 5, expiring: 2, expired: 1, none: 2 },
  ending: [
    {
      id: "c1",
      contract_number: "SN-4711",
      manufacturer: { id: "m1", name: "Acme" },
      end_date: "2026-11-01",
      state: "expiring",
      device_count: 3,
    },
  ],
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(async (path) => {
    if (path.startsWith("/api/devices/coverage-summary/")) return SUMMARY
    return { count: 0, results: [] }
  })
})
afterEach(cleanup)

function renderWidget(config?: SupportCoverageConfig) {
  const root = createRootRoute()
  const routeTree = root.addChildren([
    createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <SupportCoverageWidget config={config} />,
    }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

describe("SupportCoverageWidget", () => {
  it("shows the counts and the contracts ending soonest", async () => {
    renderWidget()
    expect(await screen.findByText("Not covered")).toBeTruthy()
    expect(screen.getByText("SN-4711")).toBeTruthy()
    expect(screen.getByText("Acme")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/devices/coverage-summary/?")
  })

  it("narrows by its site and manufacturer, and links the device list", async () => {
    renderWidget({
      site: { id: "s1", name: "HQ" },
      manufacturer: { id: "m1", name: "Acme" },
    })
    const expired = await screen.findByText("Expired")
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/devices/coverage-summary/?site=s1&manufacturer=m1"
      )
    )
    const href = expired.closest("a")?.getAttribute("href") ?? ""
    expect(href).toContain("coverage=expired")
    expect(href).toContain("site=s1")
    expect(href).toContain("manufacturer=Acme")
  })
})
