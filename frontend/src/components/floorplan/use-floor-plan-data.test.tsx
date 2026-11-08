// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanContents, FloorPlanTile } from "@/lib/api"
import { useFloorPlanData } from "./use-floor-plan-data"

// The editor opens a plan with one read of everything drawn on it - every
// tile, however many, not the first page of a tile list.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: () => Promise.resolve({ count: 0, results: [] }),
}))

const tile = (i: number) =>
  ({ id: `t${i}`, x: i % 64, y: Math.floor(i / 64) }) as FloorPlanTile

const contents: FloorPlanContents = {
  version: "2026-10-30T09:00:00Z",
  tiles: Array.from({ length: 1205 }, (_, i) => tile(i)),
  trays: [],
  walls: [],
  raised_floors: [],
  areas: [],
  labels: [],
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith("/contents/")
        ? contents
        : path.endsWith("/cable-paths/")
          ? { cables: [] }
          : { id: "p1", location: { id: "l1" }, results: [], tiles: {} }
    )
  )
})
afterEach(cleanup)

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe("useFloorPlanData", () => {
  it("loads every tile of the plan from contents/", async () => {
    const { result } = renderHook(() => useFloorPlanData("p1"), { wrapper })
    await waitFor(() => expect(result.current.serverTiles).toBeDefined())
    expect(result.current.serverTiles).toHaveLength(1205)
    expect(apiMock).toHaveBeenCalledWith("/api/floor-plans/p1/contents/")
    // No per-kind list read with a page size that could cut the plan short.
    for (const [path] of apiMock.mock.calls)
      expect(path).not.toMatch(/floor-plan-(tiles|trays|walls|raised-floors)\//)
  })
})
