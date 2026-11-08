// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ALWAYS_KEYS,
  CATALOG,
  DEFAULT_GRID_LAYOUT,
  WIDGET_KEYS,
  payloadKeys,
} from "@/components/dashboard/catalog"
import { Route as HomeRoute } from "./index"

// The grid measures its container; jsdom has no layout, so give it a width
// or no widget mounts and nothing they fetch is counted.
vi.mock("react-grid-layout", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useContainerWidth: () => ({
    width: 1200,
    mounted: true,
    containerRef: { current: null },
  }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

const PLAN = {
  id: "8d7f3b0a-1f7e-4a8e-9a55-0b9d6c1e2f30",
  name: "Hall A",
  grid_width: 10,
  grid_height: 10,
  cell_mm: 600,
  state: {},
  background_image: null,
}

const DASHBOARD = {
  counts: { prefixes: 1, ips: 2, devices: 3 },
  default_widgets: [],
  scope: {},
  frame_hours: 168,
  recent_activity: [],
  recent_prefixes: [],
  recent_devices: [],
  recent_ips: [],
  ip_by_status: [],
  ip_by_role: [],
  ip_by_scope: [],
  prefix_by_family: [],
  prefix_by_status: [],
  top_prefixes: [],
  device_by_status: [],
  device_by_type: [],
  device_by_site: [],
  device_by_manufacturer: [],
  check_by_status: [],
  alerts_by_severity: [],
  reachable_pct: null,
  flapping: [],
  availability_7d: null,
  alerts_per_day: [],
  latency_series: [],
  latency_by_kind: [],
}

const page = (results: unknown[] = []) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

/** What the server answers, by path. Anything unlisted is an empty page. */
function body(path: string): unknown {
  const [p] = path.split("?")
  if (p === "/api/me/")
    return {
      is_authenticated: true,
      is_superuser: true,
      username: "admin",
      perms: [],
      permissions: {},
    }
  if (p === "/api/me/prefs/") return { values: {}, defaults: {}, user_set: [] }
  if (p === "/api/dashboards/home/") return { id: null }
  if (p === "/api/prefs/dashboard/")
    // The built-in layout plus the widgets the owner runs: the status
    // history watching three addresses.
    return {
      source: "user",
      data: {
        v: 2,
        items: [
          ...DEFAULT_GRID_LAYOUT,
          {
            id: "status-history",
            x: 0,
            y: 30,
            w: 3,
            h: 3,
            config: {
              hours: 168,
              targets: ["a", "b", "c"].map((n) => ({
                kind: "ip",
                id: `00000000-0000-0000-0000-00000000000${n}`,
                label: n,
              })),
            },
          },
        ],
      },
    }
  if (p === "/api/dashboard/") return DASHBOARD
  if (p === "/api/site-map/")
    return {
      tiles: {
        url: "https://tile.example/{z}/{x}/{y}.png",
        attribution: "",
        osm_default: true,
        satellite: { url: "", attribution: "" },
      },
      sites: [],
      devices: [],
      markers: [],
      regions: [],
    }
  if (p === "/api/site-map/connections/") return { connections: [] }
  if (p === "/api/site-map/cables/") return { cables: [] }
  if (p === "/api/floor-plans/") return page([PLAN])
  if (p.endsWith("/timeline/"))
    return {
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-08T00:00:00Z",
      rollup: [],
      checks: [],
      summary: { uptime_pct: null },
      days: [],
    }
  if (p.endsWith("/state/")) return { tiles: {} }
  return page()
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString()
  return new Response(JSON.stringify(body(url)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderHome() {
  const root = createRootRoute()
  const routeTree = root.addChildren([
    createRoute({
      getParentRoute: () => root,
      path: "/",
      component: HomeRoute.options.component,
      validateSearch: HomeRoute.options.validateSearch,
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

const requested = () =>
  fetchMock.mock.calls.map(([input]) =>
    typeof input === "string" ? input : input.toString()
  )

describe("the home dashboard", () => {
  it("asks each endpoint once", { timeout: 30_000 }, async () => {
    renderHome()
    await screen.findByText("Hall A", undefined, { timeout: 15_000 })
    // Let every widget's queries settle, and a focus come and go.
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await new Promise((r) => setTimeout(r, 50))
    })
    const urls = requested()
    const twice = urls.filter((u, i) => urls.indexOf(u) !== i)
    expect(twice).toEqual([])
    // One payload, holding only what the widgets on show read.
    expect(urls.filter((u) => u.startsWith("/api/dashboard/"))).toEqual([
      `/api/dashboard/?include=${payloadKeys(DEFAULT_GRID_LAYOUT.map((i) => i.id)).join(",")}`,
    ])
    expect(payloadKeys(DEFAULT_GRID_LAYOUT.map((i) => i.id))).not.toContain(
      "latency_by_kind"
    )
    // Three watched addresses: three timelines, one each.
    expect(urls.filter((u) => u.includes("/timeline/"))).toHaveLength(3)
    // The page does not read every dashboard and every floor plan to show
    // a title and one plan.
    expect(urls.some((u) => u.startsWith("/api/dashboards/?"))).toBe(false)
    expect(urls).toContain("/api/floor-plans/?page_size=1")
    expect(urls).not.toContain("/api/floor-plans/?page_size=100")
  })
})

describe("the widget catalog", () => {
  it("names every payload key a widget reads", () => {
    // The page asks only for WIDGET_KEYS: a widget reading a key not listed
    // there would draw an empty chart.
    for (const w of CATALOG) {
      const read = new Set<string>()
      const d = new Proxy(DASHBOARD, {
        get(target, key) {
          if (typeof key === "string") read.add(key)
          return Reflect.get(target, key)
        },
      })
      w.render(d, { setConfig: () => {}, editing: false })
      const allowed = new Set<string>([
        ...ALWAYS_KEYS,
        ...(WIDGET_KEYS[w.id] ?? []),
      ])
      expect(
        [...read].filter((k) => !allowed.has(k)),
        w.id
      ).toEqual([])
    }
  })
})
