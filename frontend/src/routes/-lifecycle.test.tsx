// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { LifecycleOverview, LifecycleRow } from "@/lib/api"
import { Route } from "./lifecycle"

// The Lifecycle page (#436): one row per object per source, count chips per
// window that tick the Window facet, deep links that land filtered, and an
// empty state that says where the dates come from.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))
// The shell's chrome (saved views, facet prefs) is not under test: keep the
// parts this page fills in.
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    rail,
    summary,
    children,
  }: {
    rail?: ReactNode
    summary?: ReactNode
    children: ReactNode
  }) => (
    <div>
      {rail}
      {summary}
      {children}
    </div>
  ),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

function row(name: string, patch: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    object: { id: name, name, kind: "device" },
    source: "hardware",
    item: { type: "devicetype", id: "dt", name: "C9300" },
    status: "supported",
    start: "2020-01-01",
    end: "2027-06-01",
    days_left: 300,
    window: "y1",
    site: { id: "s1", name: "HQ" },
    role: null,
    tenant: { id: "t", name: "Acme" },
    manufacturer: { id: "m", name: "Cisco" },
    tags: [],
    ...patch,
  }
}

const BODY: LifecycleOverview = {
  results: [
    row("sw-gone", { status: "eol", days_left: -5, window: "past" }),
    row("sw-cov", {
      source: "coverage",
      status: "expiring",
      days_left: 30,
      window: "d90",
      item: { type: "warranty", id: null, name: "Warranty" },
    }),
    row("sw-cov-later", {
      source: "coverage",
      status: "covered",
      days_left: 200,
      window: "y1",
      item: { type: "supportcontract", id: "k", name: "K-9" },
    }),
    row("vm-os", {
      object: { id: "v", name: "vm-os", kind: "virtualmachine" },
      source: "os",
      status: "ending",
      days_left: 60,
      window: "d90",
      item: { type: "platform", id: "p", name: "Ubuntu 22.04" },
    }),
  ],
  counts: { past: 1, d90: 2, d180: 0, y1: 1, later: 0, none: 7 },
  windows: { eol_warning_days: 180, coverage_warning_days: 90 },
  eol_enabled: true,
}

let body: LifecycleOverview = BODY

beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
beforeEach(() => {
  body = BODY
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    Promise.resolve(path.startsWith("/api/lifecycle/") ? body : {})
  )
})
afterEach(cleanup)

function mount(url: string) {
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/lifecycle",
    component: Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return router
}

const shown = () =>
  ["sw-gone", "sw-cov", "sw-cov-later", "vm-os"].filter(
    (n) => screen.queryByText(n) !== null
  )

describe("the Lifecycle page", () => {
  it("lists one row per object per source with a chip per window", async () => {
    mount("/lifecycle")
    await screen.findByText("sw-gone")
    expect(shown()).toEqual(["sw-gone", "sw-cov", "sw-cov-later", "vm-os"])
    expect(screen.getByRole("button", { name: "Past 1" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "≤ 90 d 2" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "No date 7" })).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/lifecycle/")
  })

  it("lands filtered from a deep link", async () => {
    mount("/lifecycle?source=coverage&window=90")
    await screen.findByText("sw-cov")
    expect(shown()).toEqual(["sw-cov"])
  })

  it("ticks the Window facet from a chip", async () => {
    const router = mount("/lifecycle")
    await screen.findByText("sw-gone")
    fireEvent.click(screen.getByRole("button", { name: "Past 1" }))
    await waitFor(() =>
      expect(
        (router.state.location.search as Record<string, unknown>).window
      ).toBe("past")
    )
    await waitFor(() => expect(shown()).toEqual(["sw-gone"]))
    expect(
      screen
        .getByRole("button", { name: "Past 1" })
        .getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("asks for the undated rows when their chip is picked", async () => {
    const router = mount("/lifecycle")
    await screen.findByText("sw-gone")
    fireEvent.click(screen.getByRole("button", { name: "No date 7" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/lifecycle/?undated=1")
    )
    const search = router.state.location.search as Record<string, unknown>
    expect(search.window).toBe("none")
    expect(String(search.undated)).toBe("1")
  })

  it("lists installed software as its own source", async () => {
    body = {
      ...BODY,
      results: [
        ...BODY.results,
        row("db1", {
          source: "software",
          status: "eol",
          days_left: -3,
          window: "past",
          item: {
            type: "application",
            id: "a",
            name: "PostgreSQL 12",
            application: "PostgreSQL",
            version: "12",
          },
        }),
      ],
    }
    mount("/lifecycle?source=software")
    await screen.findByText("PostgreSQL 12")
    expect(screen.getByText("db1")).toBeTruthy()
    expect(shown()).toEqual([])
  })

  it("points at where the dates come from when there are none", async () => {
    body = { ...BODY, results: [], counts: { ...BODY.counts, past: 0 } }
    mount("/lifecycle")
    await screen.findByText("No end dates yet.")
    expect(
      screen.getByText("Settings → General → End-of-life data")
    ).toBeTruthy()
  })
})
