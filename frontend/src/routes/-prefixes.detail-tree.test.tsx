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
// Tree rail, the tree rooted at the page's prefix. A selected node scopes
// the tab (IPs: the addresses within it; children: it and below), and the
// tab's own Show available / Show DHCP pool compute against that node.

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
const A = prefix("a", "10.0.1.0/29")
const B = prefix("b", "10.0.8.0/22", { has_descendants: true, child_count: 1 })
const C = prefix("c", "10.0.8.0/24")
const FLAT = prefix("flat", "192.168.5.0/29")
const PREFIXES: Record<string, Prefix> = {
  root: ROOT,
  a: A,
  b: B,
  c: C,
  flat: FLAT,
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
    if (url.pathname === "/api/prefixes/tree/") {
      if (q.get("reveal")) {
        const id = q.get("reveal")!
        const below = id === "c" ? [node(B, "root", 1), node(C, "b")] : []
        return {
          vrf: null,
          path: [
            {
              id: "top",
              cidr: "10.0.0.0/8",
              parent: null,
              child_count: 1,
              index: 0,
            },
            { ...node(ROOT, "top", 2), index: 0 },
            ...(id === "a" ? [{ ...node(A, "root"), index: 0 }] : []),
            ...(id === "b" ? [{ ...node(B, "root", 1), index: 1 }] : []),
            ...below.map((n) => ({ ...n, index: n.id === "b" ? 1 : 0 })),
          ],
        }
      }
      if (q.get("q"))
        return {
          q: q.get("q"),
          count: 1,
          truncated: false,
          results: [
            { ...node(B, "root", 1), match: false },
            { ...node(C, "b"), match: true },
          ],
        }
      const parent = q.get("parent")
      const results =
        parent === "root"
          ? [node(A, "root"), node(B, "root", 1)]
          : parent === "b"
            ? [node(C, "b")]
            : []
      return { parent, count: results.length, offset: 0, limit: 200, results }
    }
    if (url.pathname === "/api/prefixes/") {
      const within = q.get("within")
      if (within === "root") return page([ROOT, A, B, C])
      if (within === "b") return page([B, C])
      if (within === "a") return page([A])
      if (within === "flat") return page([FLAT])
      return page([ROOT, A, B, C, FLAT])
    }
    const one = url.pathname.match(/^\/api\/prefixes\/(\w+)\/$/)
    if (one) return PREFIXES[one[1]]
    const ips = url.pathname.match(/^\/api\/prefixes\/(\w+)\/ips\/$/)
    if (ips) {
      if (ips[1] === "a")
        return {
          count: 1,
          results: [ip("i2", "10.0.1.2", A)],
          dhcp_ranges: [
            { scope_id: "s", name: "pool", start: "10.0.1.4", end: "10.0.1.5" },
          ],
        }
      return { count: 0, results: [], dhcp_ranges: [] }
    }
    if (url.pathname === "/api/ips/" && q.get("within") === "a")
      return page([ip("i2", "10.0.1.2", A)])
    if (url.pathname === "/api/ips/" && q.get("within") === "b")
      return page([ip("i9", "10.0.8.9", C)])
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
const addresses = () =>
  [...document.querySelectorAll("tbody tr")]
    .map((tr) => tr.textContent.match(/10\.0\.\d+\.\d+/)?.[0])
    .filter(Boolean)

describe("prefix page tree rail", () => {
  it("roots the tree at the prefix, with no VRF picker", async () => {
    setup("/prefixes/root?tab=ips&rail=tree")
    const a = await screen.findByRole("treeitem", { name: "10.0.1.0/29" })
    expect(a.getAttribute("aria-level")).toBe("1")
    const b = screen.getByRole("treeitem", { name: "10.0.8.0/22" })
    expect(b.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("treeitem", { name: "10.0.0.0/16" })).toBeNull()
    expect(screen.queryByRole("combobox", { name: "VRF" })).toBeNull()
    const tree = calls.filter((c) => c.startsWith("/api/prefixes/tree/"))
    expect(tree.some((c) => c.includes("parent=root"))).toBe(true)
    expect(tree.some((c) => c.includes("vrf="))).toBe(false)

    // Lazily expandable, and the filter box searches inside this prefix.
    fireEvent.click(b.querySelector("[aria-hidden]")!)
    expect(
      await screen.findByRole("treeitem", { name: "10.0.8.0/24" })
    ).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "Filter prefixes" }), {
      target: { value: "10.0.8" },
    })
    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("parent=root") && c.includes("q=10.0.8"))
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "10.0.1.0/29" })).toBeNull()
    )
    // A path hanging from the root sits at the top level.
    expect(
      screen
        .getByRole("treeitem", { name: "10.0.8.0/22" })
        .getAttribute("aria-level")
    ).toBe("1")
  })

  it("scopes the IPs tab to a node, with its free and pool rows", async () => {
    const router = setup("/prefixes/root?tab=ips&rail=tree")
    // The page's prefix holds others: no free rows to offer.
    await screen.findByRole("treeitem", { name: "10.0.1.0/29" })
    expect(screen.queryByText("Show available")).toBeNull()

    fireEvent.click(screen.getByRole("treeitem", { name: "10.0.1.0/29" }))
    await waitFor(() => expect(search(router).within).toBe("a"))
    await waitFor(() => expect(addresses()).toEqual(["10.0.1.2"]))
    expect(calls).toContain("/api/ips/?within=a")
    expect(await screen.findByText("Within")).toBeTruthy()

    // Show available sits under the switch and counts the /29's hosts.
    fireEvent.click(await screen.findByText("Show available"))
    await waitFor(() =>
      expect(addresses()).toEqual([
        "10.0.1.1",
        "10.0.1.2",
        "10.0.1.3",
        "10.0.1.4",
        "10.0.1.5",
        "10.0.1.6",
      ])
    )
    // The DHCP pool is the node's own.
    fireEvent.click(screen.getByText("Show available"))
    fireEvent.click(screen.getByText("Show DHCP pool"))
    await waitFor(() =>
      expect(addresses()).toEqual(["10.0.1.2", "10.0.1.4", "10.0.1.5"])
    )

    // Back to the whole prefix.
    fireEvent.click(screen.getByRole("button", { name: "Clear prefix scope" }))
    await waitFor(() => expect(search(router).within).toBeUndefined())
    await waitFor(() => expect(addresses()).toEqual([]))
  })

  it("scopes Child prefixes to a node and below", async () => {
    const router = setup("/prefixes/root?tab=children&rail=tree&within=b")
    // The path opens from the URL; the node is selected.
    const b = await screen.findByRole("treeitem", { name: "10.0.8.0/22" })
    await waitFor(() => expect(b.getAttribute("aria-selected")).toBe("true"))
    await waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain(
        "10.0.8.0/24"
      )
    )
    const body = document.querySelector("tbody")!.textContent
    expect(body).toContain("10.0.8.0/22")
    expect(body).not.toContain("10.0.1.0/29")
    expect(calls).toContain("/api/prefixes/?within=b")

    fireEvent.click(screen.getByRole("button", { name: "Clear prefix scope" }))
    await waitFor(() => expect(search(router).within).toBeUndefined())
    await waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain(
        "10.0.1.0/29"
      )
    )
    // The page's own prefix anchors the list and is not a row of it.
    expect(document.querySelector("tbody")!.textContent).not.toContain(
      "10.0.0.0/16"
    )
  })

  it("keeps mode and selection in the URL across tabs and modes", async () => {
    const router = setup("/prefixes/root?tab=ips&rail=tree&within=a")
    const a = await screen.findByRole("treeitem", { name: "10.0.1.0/29" })
    await waitFor(() => expect(a.getAttribute("aria-selected")).toBe("true"))
    // The reveal names prefixes above the page's: they are not drawn.
    expect(screen.queryByRole("treeitem", { name: "10.0.0.0/8" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    await waitFor(() => expect(search(router).rail).toBeUndefined())
    expect(screen.queryByRole("tree")).toBeNull()
    expect(search(router).within).toBe("a")
    expect(setLayout).toHaveBeenCalledWith({ order: ["filters"], hidden: [] })
    // The selection still scopes the table, as a chip.
    await waitFor(() => expect(addresses()).toEqual(["10.0.1.2"]))
    expect(
      screen.getByRole("button", { name: "Clear prefix scope" })
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Tree" }))
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    expect(setLayout).toHaveBeenLastCalledWith({ order: ["tree"], hidden: [] })
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

  it("keeps the rail's shape on a prefix with nothing inside", async () => {
    storedMode = ["tree"]
    const router = setup("/prefixes/flat?tab=ips")
    expect(await screen.findByText("No child prefixes.")).toBeTruthy()
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    // Its own toggles still work beside the empty tree.
    fireEvent.click(await screen.findByText("Show available"))
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr")).toHaveLength(6)
    )
  })
})
