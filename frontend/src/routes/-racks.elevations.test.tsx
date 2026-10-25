// @vitest-environment jsdom
import { Suspense } from "react"
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { Device, Paginated, Rack } from "@/lib/api"
import { Route } from "./racks.elevations"

// The elevations wall reads every rack's devices in one request and hands
// each rack its own (#431); it used to send one request per rack.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  createFileRoute: () => (options: object) => ({
    options,
    useSearch: () => ({}),
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
// The elevation itself is not under test: it shows what its rack's cache
// entry holds, and whether it was told the entry is already filled.
vi.mock("@/components/rack-elevation", () => ({
  RackElevation: ({
    rack,
    prefetched,
  }: {
    rack: Rack
    prefetched?: boolean
  }) => {
    const qc = useQueryClient()
    const page = qc.getQueryData<Paginated<Device>>(["rack-devices", rack.id])
    return (
      <p data-testid={`rack-${rack.id}`}>
        {String(prefetched)}:
        {page ? page.results.map((d) => d.name).join(",") : "none"}
      </p>
    )
  },
}))

const rack = (id: string) =>
  ({
    id,
    name: id.toUpperCase(),
    site: { name: "HQ" },
    width: 19,
    u_height: 42,
  }) as unknown as Rack
const device = (name: string, rackId: string) =>
  ({ id: name, name, rack: { id: rackId } }) as unknown as Device
const page = (results: unknown[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

afterEach(cleanup)
beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
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

describe("rack elevations wall", () => {
  beforeEach(() => {
    apiMock.mockReset()
  })

  it("reads every rack's devices in one request", async () => {
    apiMock.mockImplementation((path) => {
      if (path.startsWith("/api/racks/"))
        return Promise.resolve(page(["r1", "r2", "r3"].map(rack)))
      if (path.startsWith("/api/devices/"))
        return Promise.resolve(
          page([device("a", "r1"), device("b", "r3"), device("c", "r1")])
        )
      return Promise.resolve({})
    })
    mount()
    expect((await screen.findByTestId("rack-r1")).textContent).toBe("true:a,c")
    expect(screen.getByTestId("rack-r2").textContent).toBe("true:")
    expect(screen.getByTestId("rack-r3").textContent).toBe("true:b")
    const deviceCalls = apiMock.mock.calls
      .map(([p]) => p)
      .filter((p) => p.startsWith("/api/devices/"))
    expect(deviceCalls).toEqual(["/api/devices/?rack=r1,r2,r3"])
  })

  it("batches past a hundred racks", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `r${i}`)
    apiMock.mockImplementation((path) => {
      if (path.startsWith("/api/racks/"))
        return Promise.resolve(page(ids.map(rack)))
      if (path.startsWith("/api/devices/"))
        return Promise.resolve(
          page(path.includes("r149") ? [device("x", "r149")] : [])
        )
      return Promise.resolve({})
    })
    mount()
    expect((await screen.findByTestId("rack-r149")).textContent).toBe("true:x")
    const deviceCalls = apiMock.mock.calls
      .map(([p]) => p)
      .filter((p) => p.startsWith("/api/devices/"))
    expect(deviceCalls).toHaveLength(2)
  })
})
