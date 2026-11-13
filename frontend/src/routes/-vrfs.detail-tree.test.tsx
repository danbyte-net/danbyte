// @vitest-environment jsdom
import { createContext, useContext } from "react"
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within as inside,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
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

import type { IPAddress, Prefix, VRF } from "@/lib/api"
import { Route as DetailRoute } from "./vrfs.$id"

// A VRF page's Prefixes and IPs tabs carry the lists' Filters / Tree rail,
// the tree fixed to the VRF: its top-level prefixes, no VRF picker. A
// selected node scopes both tabs on the server (`vrf=` and `within=`).

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", async (orig) => ({
  ...(await orig<object>()),
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/vrf-delete-dialog", () => ({
  VrfDeleteDialog: () => null,
}))
const setLayout = vi.fn()
const prefKeys: string[] = []
let storedMode: string[] = []
vi.mock("@/lib/use-table-preference", () => ({
  layoutShows: () => false,
  useTablePreference: (id?: string) => {
    if (id) prefKeys.push(id)
    const rail = !!id?.startsWith("rail-")
    return {
      order: rail ? storedMode : [],
      hidden: [],
      pinned: [],
      isForced: false,
      hasUserRow: false,
      presetName: null,
      source: "none",
      loaded: true,
      setLayout: rail ? setLayout : () => {},
      reset: () => {},
    }
  },
}))
// The shell: the active tab's pane only.
const TabCtx = createContext("overview")
vi.mock("@/components/detail-shell", () => ({
  DetailShell: ({ tab, children }: { tab: string; children: ReactNode }) => (
    <TabCtx.Provider value={tab}>{children}</TabCtx.Provider>
  ),
  DetailHero: () => null,
  DetailTab: ({ value, children }: { value: string; children: ReactNode }) =>
    useContext(TabCtx) === value ? <section>{children}</section> : null,
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
Element.prototype.scrollIntoView = () => {}
window.scrollTo = () => {}

const LAB = {
  id: "lab",
  numid: null,
  name: "LAB",
  rd: "",
  color: "",
  description: "",
  enforce_unique: false,
  import_targets: [],
  export_targets: [],
  tags: [],
  custom_fields: {},
  prefix_count: 4,
  ip_count: 2,
  vlan_count: 0,
  bgp_session_count: 0,
  static_route_count: 0,
} as unknown as VRF

const prefix = (id: string, cidr: string): Prefix =>
  ({
    id,
    numid: null,
    cidr,
    status: null,
    family: 4,
    utilisation_pct: 0,
    is_enumerable: false,
    ip_count: 0,
    child_count: 0,
    has_descendants: false,
    site: null,
    location: null,
    vlan: null,
    vrf: { id: "lab", name: "LAB" },
    gateway: null,
    description: "",
    tags: [],
    custom_fields: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }) as unknown as Prefix
// LAB: 10.0.0.0/16 > 10.0.8.0/22 > 10.0.8.0/24, and 192.168.0.0/24.
const A = prefix("a", "10.0.0.0/16")
const B = prefix("b", "10.0.8.0/22")
const C = prefix("c", "10.0.8.0/24")
const D = prefix("d", "192.168.0.0/24")

const ip = (id: string, address: string, on: Prefix) =>
  ({
    id,
    ip_address: address,
    prefix: { id: on.id, cidr: on.cidr },
    status: null,
    role: null,
    tags: [],
    custom_fields: {},
    description: "",
  }) as unknown as IPAddress

const node = (p: Prefix, parent: string | null, child_count = 0) => ({
  id: p.id,
  cidr: p.cidr,
  parent,
  child_count,
})
const page = <T,>(results: T[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const calls: string[] = []
beforeEach(() => {
  calls.length = 0
  prefKeys.length = 0
  storedMode = []
  setLayout.mockClear()
  apiMock.mockReset()
  apiMock.mockImplementation(async (path: string) => {
    calls.push(path)
    const url = new URL(path, "http://x")
    const q = url.searchParams
    if (url.pathname === "/api/vrfs/lab/") return LAB
    if (url.pathname === "/api/prefixes/tree/") {
      const reveal = q.get("reveal")
      if (reveal === "b")
        return {
          vrf: "lab",
          path: [
            { ...node(A, null, 1), index: 0 },
            { ...node(B, "a", 1), index: 0 },
          ],
        }
      if (reveal === "x")
        return {
          vrf: "other",
          path: [
            {
              id: "x",
              cidr: "10.0.0.0/8",
              parent: null,
              child_count: 0,
              index: 0,
            },
          ],
        }
      if (q.get("q"))
        return {
          q: q.get("q"),
          count: 1,
          truncated: false,
          results: [
            { ...node(A, null, 1), match: false },
            { ...node(B, "a", 1), match: true },
          ],
        }
      const parent = q.get("parent")
      const results =
        parent === "a"
          ? [node(B, "a", 1)]
          : parent === "b"
            ? [node(C, "b")]
            : parent === null && q.get("vrf") === "lab"
              ? [node(A, null, 1), node(D, null)]
              : []
      return { parent, count: results.length, offset: 0, limit: 200, results }
    }
    if (url.pathname === "/api/prefixes/" && q.get("vrf") === "lab") {
      const w = q.get("within")
      if (w === "b") return page([B, C])
      if (w) return page([])
      return page([A, B, C, D])
    }
    if (url.pathname === "/api/ips/" && q.get("vrf") === "lab") {
      const w = q.get("within")
      if (w === "b") return page([ip("i1", "10.0.8.9", C)])
      if (w) return page([])
      return page([ip("i1", "10.0.8.9", C), ip("i2", "192.168.0.5", D)])
    }
    if (url.pathname === "/api/custom-fields/") return page([])
    if (url.pathname === "/api/monitoring/status/") return { statuses: {} }
    return new Promise(() => undefined)
  })
})
afterEach(cleanup)
beforeAll(async () => {
  // The route component is code-split.
  const lazy = DetailRoute.options.component as {
    preload?: () => Promise<void>
  }
  await lazy.preload?.()
})

function setup(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/vrfs/$id",
    component: DetailRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([detail]),
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
const search = (router: ReturnType<typeof setup>) =>
  router.state.location.search as Record<string, unknown>
const cells = (re: RegExp) =>
  [...document.querySelectorAll("tbody tr")]
    .map((tr) => tr.textContent.match(re)?.[0])
    .filter(Boolean)
const prefixRows = () => cells(/\d+\.\d+\.\d+\.\d+\/\d+/)
const addresses = () => cells(/\d+\.\d+\.\d+\.\d+(?!\/)/)

describe("VRF page tree rail", () => {
  it("roots the tree at the VRF's top level, with no VRF picker", async () => {
    setup("/vrfs/lab?tab=prefixes&rail=tree")
    const a = await screen.findByRole("treeitem", { name: "10.0.0.0/16" })
    expect(a.getAttribute("aria-level")).toBe("1")
    expect(
      screen
        .getByRole("treeitem", { name: "192.168.0.0/24" })
        .getAttribute("aria-level")
    ).toBe("1")
    expect(screen.queryByRole("combobox", { name: "VRF" })).toBeNull()
    expect(calls.some((c) => c.startsWith("/api/vrfs/?picker"))).toBe(false)
    const tree = calls.filter((c) => c.startsWith("/api/prefixes/tree/"))
    expect(tree.some((c) => c.includes("vrf=lab"))).toBe(true)

    // Lazy levels, and the filter box searches inside this VRF.
    fireEvent.click(a.querySelector("[aria-hidden]")!)
    expect(
      await screen.findByRole("treeitem", { name: "10.0.8.0/22" })
    ).toBeTruthy()
    expect(calls).toContain("/api/prefixes/tree/?offset=0&limit=200&parent=a")
    fireEvent.change(screen.getByRole("textbox", { name: "Filter prefixes" }), {
      target: { value: "10.0.8" },
    })
    await waitFor(() =>
      expect(calls).toContain("/api/prefixes/tree/?vrf=lab&q=10.0.8")
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: "192.168.0.0/24" })
      ).toBeNull()
    )
  })

  it("scopes the Prefixes tab to a node on the server", async () => {
    const router = setup("/vrfs/lab?tab=prefixes&rail=tree")
    await waitFor(() => expect(prefixRows()).toHaveLength(4))
    expect(calls).toContain("/api/prefixes/?vrf=lab")

    fireEvent.click(
      (
        await screen.findByRole("treeitem", { name: "10.0.0.0/16" })
      ).querySelector("[aria-hidden]")!
    )
    fireEvent.click(
      await screen.findByRole("treeitem", { name: "10.0.8.0/22" })
    )
    await waitFor(() => expect(search(router).within).toBe("b"))
    await waitFor(() =>
      expect(prefixRows()).toEqual(["10.0.8.0/22", "10.0.8.0/24"])
    )
    expect(calls).toContain("/api/prefixes/?vrf=lab&within=b")
    expect(search(router).tree_vrf).toBeUndefined()
    expect(await screen.findByText("Within")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Clear prefix scope" }))
    await waitFor(() => expect(search(router).within).toBeUndefined())
    await waitFor(() => expect(prefixRows()).toHaveLength(4))
  })

  it("scopes the IPs tab with within= on the server", async () => {
    setup("/vrfs/lab?tab=ips&rail=tree&within=b")
    // The path opens from the URL; the node is selected.
    const b = await screen.findByRole("treeitem", { name: "10.0.8.0/22" })
    await waitFor(() => expect(b.getAttribute("aria-selected")).toBe("true"))
    await waitFor(() => expect(addresses()).toEqual(["10.0.8.9"]))
    expect(calls).toContain("/api/ips/?vrf=lab&within=b")
    // Never the whole VRF to filter in the browser.
    expect(calls).not.toContain("/api/ips/?vrf=lab")
  })

  it("keeps mode, tab and selection in the URL", async () => {
    const router = setup("/vrfs/lab?tab=ips&rail=tree&within=b")
    await waitFor(() => expect(addresses()).toEqual(["10.0.8.9"]))

    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    await waitFor(() => expect(search(router).rail).toBeUndefined())
    expect(screen.queryByRole("tree")).toBeNull()
    expect(search(router).within).toBe("b")
    expect(search(router).tab).toBe("ips")
    expect(setLayout).toHaveBeenCalledWith({ order: ["filters"], hidden: [] })
    // The selection still scopes the table, as a chip; the facets show.
    expect(addresses()).toEqual(["10.0.8.9"])
    expect(
      screen.getByRole("button", { name: "Clear prefix scope" })
    ).toBeTruthy()

    // The other tab shares the selection.
    await router.navigate({
      to: "/vrfs/$id",
      params: { id: "lab" },
      search: { ...search(router), tab: "prefixes" },
    })
    await waitFor(() =>
      expect(prefixRows()).toEqual(["10.0.8.0/22", "10.0.8.0/24"])
    )

    fireEvent.click(screen.getByRole("button", { name: "Tree" }))
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    expect(setLayout).toHaveBeenLastCalledWith({ order: ["tree"], hidden: [] })
  })

  it("ignores a selection from another VRF", async () => {
    setup("/vrfs/lab?tab=prefixes&rail=tree&within=x")
    expect(await screen.findByText("unknown prefix")).toBeTruthy()
    await waitFor(() => expect(prefixRows()).toHaveLength(4))
  })

  it("opens a stored Tree on the table tabs only, under its own preference", async () => {
    storedMode = ["tree"]
    const router = setup("/vrfs/lab?tab=ips")
    expect(await screen.findByRole("tree", { name: "Prefixes" })).toBeTruthy()
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    expect(prefKeys).toContain("rail-vrf-detail")
    expect(prefKeys).not.toContain("rail-prefix-detail")
    expect(prefKeys).not.toContain("rail-ips")
    cleanup()

    const other = setup("/vrfs/lab")
    await waitFor(() => expect(calls).toContain("/api/vrfs/lab/"))
    await new Promise((r) => setTimeout(r, 20))
    expect(search(other).rail).toBeUndefined()
  })

  it("opens the rail in a sheet on a narrow window", async () => {
    const router = setup("/vrfs/lab?tab=prefixes&rail=tree")
    await screen.findAllByRole("treeitem", { name: "10.0.0.0/16" })
    const trigger = screen
      .getAllByRole("button", { name: "Tree" })
      .find((b) => b.getAttribute("aria-haspopup") === "dialog")!
    expect(trigger.className).toContain("lg:hidden")
    fireEvent.click(trigger)
    const sheet = await screen.findByRole("dialog")
    fireEvent.click(
      await inside(sheet).findByRole("treeitem", { name: "192.168.0.0/24" })
    )
    await waitFor(() => expect(search(router).within).toBe("d"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
