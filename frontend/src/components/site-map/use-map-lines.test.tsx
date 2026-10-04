// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { invalidateSiteViews } from "@/lib/site-cache"
import { MiniMap } from "./mini-map"
import {
  MAP_CABLES_KEY,
  MAP_CONNECTIONS_KEY,
  useMapCables,
  useMapConnections,
} from "./use-map-lines"

// The site map page asks for its lines' speeds (`?include=capacity`, #246)
// under keys of its own. The dashboard widget and the site and device
// locators share the bare keys and the plain payload: they make no new
// request and never receive the heavier one - and every invalidation of
// the bare keys still refreshes the page.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => () => {},
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
  ResizeObserverStub

const site = (id: string, lng: number) => ({
  id,
  name: id,
  latitude: 55,
  longitude: lng,
})
const EDGE = {
  id: "circuit:1",
  kind: "circuit",
  name: "C-1",
  site_a: site("a", 10),
  site_z: site("z", 12),
  color: "",
  status: null,
  meta: {},
}
const PLAIN = { connections: [EDGE] }
const RICH = {
  connections: [
    {
      ...EDGE,
      capacity: {
        kbps: 10_000_000,
        up_kbps: null,
        source: "commit",
        label: "10G",
        count: 1,
        unknown: 0,
      },
      links: [],
      link_count: 1,
    },
  ],
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path === "/api/site-map/connections/?include=capacity")
      return Promise.resolve(RICH)
    if (path === "/api/site-map/connections/") return Promise.resolve(PLAIN)
    if (path.startsWith("/api/site-map/cables/"))
      return Promise.resolve({ cables: [] })
    if (path === "/api/site-map/")
      return Promise.resolve({
        tiles: {
          url: "https://tile.example/{z}/{x}/{y}.png",
          attribution: "",
          satellite: { url: "", attribution: "" },
        },
        sites: [],
        devices: [],
        markers: [],
      })
    return Promise.resolve({
      count: 0,
      next: null,
      previous: null,
      results: [],
    })
  })
})
afterEach(cleanup)

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )

const paths = () => apiMock.mock.calls.map(([p]) => p)

describe("the site map page's lines", () => {
  it("ask for capacity under their own keys", async () => {
    const qc = client()
    const { result } = renderHook(
      () => ({ conns: useMapConnections(), cables: useMapCables() }),
      { wrapper: wrap(qc) }
    )
    await waitFor(() => expect(result.current.conns.data).toEqual(RICH))
    await waitFor(() => expect(result.current.cables.isSuccess).toBe(true))
    expect(paths()).toEqual(
      expect.arrayContaining([
        "/api/site-map/connections/?include=capacity",
        "/api/site-map/cables/?include=capacity",
      ])
    )
    expect(qc.getQueryData(MAP_CONNECTIONS_KEY)).toEqual(RICH)
    expect(qc.getQueryData(MAP_CABLES_KEY)).toEqual({ cables: [] })
    // The bare keys stay the mini maps'.
    expect(qc.getQueryData(["site-map-connections"])).toBeUndefined()
    expect(qc.getQueryData(["site-map-cables"])).toBeUndefined()
  })

  it("refresh when the site views are invalidated", async () => {
    const qc = client()
    const { result } = renderHook(() => useMapConnections(), {
      wrapper: wrap(qc),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    apiMock.mockClear()
    invalidateSiteViews(qc)
    await waitFor(() =>
      expect(paths()).toContain("/api/site-map/connections/?include=capacity")
    )
  })
})

describe("the mini maps", () => {
  it("keep the plain payload under the bare keys, beside the page's", async () => {
    const qc = client()
    render(
      <QueryClientProvider client={qc}>
        <MiniMap />
      </QueryClientProvider>
    )
    const { result } = renderHook(() => useMapConnections(), {
      wrapper: wrap(qc),
    })
    await waitFor(() =>
      expect(qc.getQueryData(["site-map-connections"])).toEqual(PLAIN)
    )
    await waitFor(() => expect(result.current.data).toEqual(RICH))
    await waitFor(() =>
      expect(qc.getQueryData(["site-map-cables"])).toEqual({ cables: [] })
    )
    const mine = paths().filter((p) => p.startsWith("/api/site-map/"))
    // The mini map asked for what it always did - once each, no capacity.
    expect(mine.filter((p) => p === "/api/site-map/connections/")).toHaveLength(
      1
    )
    expect(mine.filter((p) => p === "/api/site-map/cables/")).toHaveLength(1)
    // Only the page's own query carries it.
    expect(mine.filter((p) => p.includes("include=capacity"))).toEqual([
      "/api/site-map/connections/?include=capacity",
    ])
  })
})
