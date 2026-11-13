// @vitest-environment jsdom
import { createContext, useContext } from "react"
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

import type { IPAddress, Prefix } from "@/lib/api"
import { Route as DetailRoute } from "./prefixes.$id"

// A prefix page's IPs and Child prefixes tabs carry the lists' Filters /
// Tree rail as navigation: the branch the prefix sits in, opened down to it
// with its siblings around it. A picked prefix opens its own page on the
// same tab, the tree kept; the tabs always show the page's prefix.

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

// 10.0.0.0/16 (the page) > {10.0.1.0/29, 10.0.8.0/22 > 10.0.8.0/24}, all
// under a 10.0.0.0/8 the reveal path names above the page's prefix.
const prefix = (
  id: string,
  cidr: string,
  patch: Partial<Prefix> = {}
): Prefix => ({
  id,
  numid: null,
  cidr,
  status: null,
  family: 4,
  utilisation_pct: 0,
  is_enumerable: true,
  ip_count: 0,
  child_count: 0,
  has_descendants: false,
  site: null,
  location: null,
  vlan: null,
  vlan_vrf_mismatch: false,
  vrf: null,
  gateway: null,
  description: "",
  auto_discover: false,
  auto_assign_site: false,
  allocate_from_ranges: false,
  allocation: null,
  auto_gateway: false,
  tags: [],
  custom_fields: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...patch,
})
const ROOT = prefix("root", "10.0.0.0/16", {
  is_enumerable: false,
  has_descendants: true,
  child_count: 2,
})
const TOP = prefix("top", "10.0.0.0/8", { has_descendants: true })
const SIB = prefix("sib", "10.1.0.0/16")
const A = prefix("a", "10.0.1.0/29")
const B = prefix("b", "10.0.8.0/22", { has_descendants: true, child_count: 1 })
const C = prefix("c", "10.0.8.0/24")
const FLAT = prefix("flat", "192.168.5.0/29")
// 172.16.0.0/12 > (a hidden /16) > 172.16.4.0/24: the reveal skips the /16.
const OUTER = prefix("outer", "172.16.0.0/12")
const UNDER = prefix("under", "172.16.4.0/24")
// 10.200.0.0/16 holds 1,000 /29s; "deep" is the 451st.
const BIG = prefix("big", "10.200.0.0/16", { has_descendants: true })
const DEEP = prefix("deep", "10.200.1.200/29")
const PREFIXES: Record<string, Prefix> = {
  root: ROOT,
  top: TOP,
  sib: SIB,
  a: A,
  b: B,
  c: C,
  flat: FLAT,
  outer: OUTER,
  under: UNDER,
  big: BIG,
  deep: DEEP,
}

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
const step = (n: ReturnType<typeof node>, index: number) => ({ ...n, index })
const page = <T,>(results: T[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const PATHS: Record<string, ReturnType<typeof step>[]> = {
  root: [step(node(TOP, null, 2), 0), step(node(ROOT, "top", 2), 0)],
  a: [
    step(node(TOP, null, 2), 0),
    step(node(ROOT, "top", 2), 0),
    step(node(A, "root"), 0),
  ],
  sib: [step(node(TOP, null, 2), 0), step(node(SIB, "top"), 1)],
  b: [
    step(node(TOP, null, 2), 0),
    step(node(ROOT, "top", 2), 0),
    step(node(B, "root", 1), 1),
  ],
  flat: [step(node(FLAT, null), 3)],
  under: [step(node(OUTER, null, 1), 2), step(node(UNDER, "outer"), 0)],
  deep: [step(node(BIG, null, 1000), 4), step(node(DEEP, "big"), 450)],
}
const CHILDREN: Record<string, ReturnType<typeof node>[]> = {
  top: [node(ROOT, "top", 2), node(SIB, "top")],
  root: [node(A, "root"), node(B, "root", 1)],
  b: [node(C, "b")],
  outer: [node(UNDER, "outer")],
}

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
    if (url.pathname === "/api/prefixes/tree/") {
      const reveal = q.get("reveal")
      if (reveal) return { vrf: null, path: PATHS[reveal] }
      if (q.get("q"))
        return {
          q: q.get("q"),
          count: 1,
          truncated: false,
          results: [
            { ...node(ROOT, "top", 2), match: false },
            { ...node(B, "root", 1), match: true },
          ],
        }
      const parent = q.get("parent")!
      const offset = Number(q.get("offset"))
      if (parent === "big") {
        const results = Array.from({ length: 200 }, (_, i) => {
          const n = offset + i
          return n === 450
            ? node(DEEP, "big")
            : { id: `s${n}`, cidr: `10.200.${n}.0/29`, parent, child_count: 0 }
        })
        return { parent, count: 1000, offset, limit: 200, results }
      }
      const results = CHILDREN[parent] ?? []
      return { parent, count: results.length, offset, limit: 200, results }
    }
    if (url.pathname === "/api/prefixes/") {
      const within = q.get("within")
      if (within === "root") return page([ROOT, A, B, C])
      if (within === "flat") return page([FLAT])
      return page([])
    }
    const one = url.pathname.match(/^\/api\/prefixes\/(\w+)\/$/)
    if (one) return PREFIXES[one[1]]
    const ips = url.pathname.match(/^\/api\/prefixes\/(\w+)\/ips\/$/)
    if (ips) {
      if (ips[1] === "root")
        return { count: 1, results: [ip("i2", "10.0.1.2", A)], dhcp_ranges: [] }
      return { count: 0, results: [], dhcp_ranges: [] }
    }
    if (url.pathname === "/api/ip-ranges/") return page([])
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
    path: "/prefixes/$id",
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
const item = (name: string) => screen.findByRole("treeitem", { name })
const level = (el: HTMLElement) => el.getAttribute("aria-level")

describe("prefix page tree rail", () => {
  it("opens the branch down to this prefix, its siblings around it", async () => {
    setup("/prefixes/root?tab=ips&rail=tree")
    const here = await item("10.0.0.0/16")
    expect(level(await item("10.0.0.0/8"))).toBe("1")
    expect(level(here)).toBe("2")
    expect(here.getAttribute("aria-current")).toBe("page")
    expect(here.getAttribute("aria-expanded")).toBe("true")
    expect(here.textContent).toContain("This prefix")
    // Its sibling under the same master, and its own children.
    expect(level(await item("10.1.0.0/16"))).toBe("2")
    expect(level(await item("10.0.1.0/29"))).toBe("3")
    expect(screen.queryByRole("combobox", { name: "VRF" })).toBeNull()
    expect(calls).toContain("/api/prefixes/tree/?reveal=root")
    expect(calls).toContain("/api/prefixes/tree/?offset=0&limit=200&parent=top")
    expect(calls).toContain(
      "/api/prefixes/tree/?offset=0&limit=200&parent=root"
    )
    // The table is this prefix's own.
    expect(calls).toContain("/api/prefixes/root/ips/")
    expect(calls.some((c) => c.includes("within="))).toBe(false)
  })

  it("opens a picked prefix's page, same tab, tree kept", async () => {
    const router = setup("/prefixes/root?tab=ips&rail=tree")
    // This prefix: nothing happens.
    fireEvent.click(await item("10.0.0.0/16"))
    await new Promise((r) => setTimeout(r, 20))
    expect(router.state.location.pathname).toBe("/prefixes/root")

    // A child inside it: its page, not a scope.
    fireEvent.click(await item("10.0.1.0/29"))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/prefixes/a")
    )
    expect(search(router)).toEqual({ tab: "ips", rail: "tree" })
    // The tree centres on it there.
    await waitFor(async () =>
      expect((await item("10.0.1.0/29")).getAttribute("aria-current")).toBe(
        "page"
      )
    )
    expect(calls).toContain("/api/prefixes/tree/?reveal=a")

    // A sibling of the master's.
    fireEvent.click(await item("10.1.0.0/16"))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/prefixes/sib")
    )
    expect(search(router).rail).toBe("tree")
  })

  it("moves with the arrows and opens with Enter", async () => {
    const router = setup("/prefixes/root?tab=children&rail=tree")
    await item("10.0.1.0/29")
    const tree = screen.getByRole("tree", { name: "Prefixes" })
    // The active row starts at this prefix; Enter there does nothing.
    fireEvent.keyDown(tree, { key: "Enter" })
    fireEvent.keyDown(tree, { key: "ArrowDown" })
    await new Promise((r) => setTimeout(r, 20))
    expect(router.state.location.pathname).toBe("/prefixes/root")
    fireEvent.keyDown(tree, { key: "Enter" })
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/prefixes/a")
    )
    expect(search(router)).toEqual({ tab: "children", rail: "tree" })
  })

  it("searches the whole branch and opens a match", async () => {
    const router = setup("/prefixes/root?tab=ips&rail=tree")
    await item("10.0.1.0/29")
    fireEvent.change(screen.getByRole("textbox", { name: "Filter prefixes" }), {
      target: { value: "10.0.8" },
    })
    await waitFor(() =>
      expect(calls).toContain("/api/prefixes/tree/?parent=top&q=10.0.8")
    )
    await waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "10.1.0.0/16" })).toBeNull()
    )
    expect(level(await item("10.0.0.0/8"))).toBe("1")
    fireEvent.click(await item("10.0.8.0/22"))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/prefixes/b")
    )
  })

  it("ignores a within= in the URL", async () => {
    setup("/prefixes/root?tab=children&rail=tree&within=b")
    await waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain(
        "10.0.1.0/29"
      )
    )
    expect(calls).toContain("/api/prefixes/?within=root")
    expect(calls).not.toContain("/api/prefixes/?within=b")
    expect(
      screen.queryByRole("button", { name: "Clear prefix scope" })
    ).toBeNull()
  })

  it("opens a long sibling list at the page that holds this prefix", async () => {
    setup("/prefixes/deep?tab=ips&rail=tree")
    const here = await item("10.200.1.200/29")
    expect(here.getAttribute("aria-posinset")).toBe("451")
    expect(here.getAttribute("aria-setsize")).toBe("1000")
    expect(calls).toContain(
      "/api/prefixes/tree/?offset=400&limit=200&parent=big"
    )
    expect(calls.some((c) => c.includes("offset=0&limit=200&parent=big"))).toBe(
      false
    )
    expect(
      screen.getByRole("treeitem", { name: "Show 200 earlier" })
    ).toBeTruthy()
    expect(screen.getByRole("treeitem", { name: "Show 200 more" })).toBeTruthy()
    fireEvent.click(screen.getByRole("treeitem", { name: "Show 200 earlier" }))
    await waitFor(() =>
      expect(calls).toContain(
        "/api/prefixes/tree/?offset=200&limit=200&parent=big"
      )
    )
    fireEvent.click(screen.getByRole("treeitem", { name: "Show 200 more" }))
    await waitFor(() =>
      expect(calls).toContain(
        "/api/prefixes/tree/?offset=600&limit=200&parent=big"
      )
    )
  })

  it("never names a hidden ancestor", async () => {
    setup("/prefixes/under?tab=ips&rail=tree")
    const here = await item("172.16.4.0/24")
    expect(level(here)).toBe("2")
    expect(level(await item("172.16.0.0/12"))).toBe("1")
    expect(screen.queryByText(/172\.16\.0\.0\/16/)).toBeNull()
  })

  it("shows a top-level leaf as the whole tree", async () => {
    storedMode = ["tree"]
    const router = setup("/prefixes/flat?tab=ips")
    const here = await item("192.168.5.0/29")
    expect(level(here)).toBe("1")
    expect(here.getAttribute("aria-expanded")).toBeNull()
    expect(screen.queryByText("No child prefixes.")).toBeNull()
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    // Its own toggles still work beside the tree.
    fireEvent.click(await screen.findByText("Show available"))
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr")).toHaveLength(6)
    )
  })

  it("opens a stored Tree on the table tabs only, under one preference", async () => {
    storedMode = ["tree"]
    const router = setup("/prefixes/root?tab=ips")
    expect(await screen.findByRole("tree", { name: "Prefixes" })).toBeTruthy()
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    expect(prefKeys).toContain("rail-prefix-detail")
    expect(prefKeys).not.toContain("rail-ips")
    expect(prefKeys).not.toContain("rail-prefixes")
    cleanup()

    const other = setup("/prefixes/root")
    await waitFor(() => expect(calls).toContain("/api/prefixes/root/"))
    await new Promise((r) => setTimeout(r, 20))
    expect(search(other).rail).toBeUndefined()
  })

  it("switches modes in the URL", async () => {
    const router = setup("/prefixes/root?tab=ips&rail=tree")
    await item("10.0.1.0/29")
    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    await waitFor(() => expect(search(router).rail).toBeUndefined())
    expect(screen.queryByRole("tree")).toBeNull()
    expect(setLayout).toHaveBeenCalledWith({ order: ["filters"], hidden: [] })
    fireEvent.click(screen.getByRole("button", { name: "Tree" }))
    await waitFor(() => expect(search(router).rail).toBe("tree"))
  })
})
