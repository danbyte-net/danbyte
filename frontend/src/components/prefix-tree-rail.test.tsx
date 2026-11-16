// @vitest-environment jsdom
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TreeNode } from "@/lib/prefix-tree-nav"

import {
  TreeOrFilterRail,
  WithinChip,
  usePrefixTreeRail,
} from "./prefix-tree-rail"

// ─── A mocked tree API ────────────────────────────────────────────────────
// Global VRF: 10.0.0.0/8 > {10.1.0.0/16 > 10.1.2.0/24, 10.9.4.0/24}; the
// 10.9.0.0/16 between the /8 and 10.9.4.0/24 is hidden from this reader,
// so the server hangs the /24 from the /8 and never names the /16.

const n = (
  id: string,
  cidr: string,
  child_count = 0,
  parent: string | null = null
): TreeNode => ({
  id,
  cidr,
  child_count,
  parent,
})
const LEVELS: Record<string, TreeNode[]> = {
  root: [n("p8", "10.0.0.0/8", 2), n("p192", "192.168.0.0/16")],
  p8: [n("p16", "10.1.0.0/16", 1, "p8"), n("p94", "10.9.4.0/24", 0, "p8")],
  p16: [n("p24", "10.1.2.0/24", 0, "p16")],
}
const calls: string[] = []
const setLayout = vi.fn()
let storedMode: string[] = []

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    calls.push(path)
    const url = new URL(path, "http://x")
    const p = url.searchParams
    if (p.get("reveal")) {
      const id = p.get("reveal")!
      const chain =
        id === "p24"
          ? ["p8", "p16", "p24"]
          : id === "p16"
            ? ["p8", "p16"]
            : ["p8"]
      const all = Object.values(LEVELS).flat()
      return {
        vrf: null,
        path: chain.map((c) => ({ ...all.find((x) => x.id === c)!, index: 0 })),
      }
    }
    if (p.get("q")) {
      return {
        q: p.get("q"),
        count: 1,
        truncated: false,
        results: [
          { ...LEVELS.root[0], match: false },
          { ...LEVELS.p8[1], match: true },
        ],
      }
    }
    const parent = p.get("parent") ?? "root"
    const results = LEVELS[parent] ?? []
    return {
      parent: p.get("parent"),
      count: results.length,
      offset: 0,
      limit: 200,
      results,
    }
  }),
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: vi.fn(async () => ({
    count: 1,
    results: [{ id: "v1", name: "CORP", rd: "", color: "" }],
  })),
}))
vi.mock("@/lib/use-table-preference", () => ({
  useTablePreference: () => ({
    order: storedMode,
    hidden: [],
    pinned: [],
    loaded: true,
    setLayout,
    reset: () => {},
  }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as Record<string, unknown>).ResizeObserver ??=
  ResizeObserverStub

function Page() {
  const rail = usePrefixTreeRail("prefixes")
  return (
    <div>
      <TreeOrFilterRail rail={rail} filterRail={<div>filter facets</div>} />
      <WithinChip rail={rail} />
      <output data-testid="scope">{JSON.stringify(rail.scopeParams)}</output>
    </div>
  )
}

function setup(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const list = createRoute({
    getParentRoute: () => root,
    path: "/prefixes",
    component: Page,
  })
  const router = createRouter({
    routeTree: root.addChildren([list]),
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

beforeEach(() => {
  calls.length = 0
  storedMode = []
  setLayout.mockClear()
})
afterEach(cleanup)

describe("prefix tree rail", () => {
  it("keeps the filters by default", async () => {
    setup("/prefixes?status=s1")
    expect(await screen.findByText("filter facets")).toBeTruthy()
    expect(screen.queryByRole("tree")).toBeNull()
    expect(screen.getByTestId("scope").textContent).toBe("{}")
  })

  it("opens on a stored Tree and puts it in the URL", async () => {
    storedMode = ["tree"]
    const router = setup("/prefixes")
    expect(await screen.findByRole("tree", { name: "Prefixes" })).toBeTruthy()
    await waitFor(() => expect(search(router).rail).toBe("tree"))
    // The tree's VRF scopes the table while nothing is selected.
    expect(screen.getByTestId("scope").textContent).toBe('{"vrf":"global"}')
    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    await waitFor(() => expect(search(router).rail).toBeUndefined())
    expect(setLayout).toHaveBeenCalledWith({ order: ["filters"], hidden: [] })
  })

  it("loads one level per opened node and selects into the URL", async () => {
    const router = setup("/prefixes?rail=tree&status=s1")
    const root = await screen.findByRole("treeitem", { name: "10.0.0.0/8" })
    expect(root.getAttribute("aria-expanded")).toBe("false")
    expect(calls.filter((c) => c.includes("parent="))).toEqual([])
    expect(root.textContent).toContain("2") // its count badge
    expect(
      screen
        .getByRole("treeitem", { name: "192.168.0.0/16" })
        .getAttribute("aria-expanded")
    ).toBeNull()

    const tree = screen.getByRole("tree")
    tree.focus()
    fireEvent.keyDown(tree, { key: "ArrowRight" })
    expect(
      await screen.findByRole("treeitem", { name: "10.1.0.0/16" })
    ).toBeTruthy()
    expect(calls.some((c) => c.includes("parent=p8"))).toBe(true)
    // The hidden /16 is never drawn; its visible /24 sits under the /8.
    const under = screen.getByRole("treeitem", { name: "10.9.4.0/24" })
    expect(under.getAttribute("aria-level")).toBe("2")
    expect(document.body.textContent).not.toContain("10.9.0.0")

    fireEvent.keyDown(tree, { key: "ArrowDown" })
    expect(tree.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("treeitem", { name: "10.1.0.0/16" }).id
    )
    fireEvent.keyDown(tree, { key: "Enter" })
    await waitFor(() => expect(search(router).within).toBe("p16"))
    // Composes with the list's own filters.
    expect(search(router).status).toBe("s1")
    expect(screen.getByTestId("scope").textContent).toBe('{"within":"p16"}')
    expect(
      screen
        .getByRole("treeitem", { name: "10.1.0.0/16" })
        .getAttribute("aria-selected")
    ).toBe("true")

    fireEvent.keyDown(tree, { key: "ArrowLeft" })
    fireEvent.keyDown(tree, { key: "End" })
    expect(tree.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("treeitem", { name: "192.168.0.0/16" }).id
    )
  })

  it("collapses with the chevron and keeps the scope as a chip in Filters", async () => {
    const router = setup("/prefixes?rail=tree&within=p24")
    // The path to the selection opens from the URL.
    const sel = await screen.findByRole("treeitem", { name: "10.1.2.0/24" })
    expect(sel.getAttribute("aria-selected")).toBe("true")
    expect(sel.getAttribute("aria-level")).toBe("3")
    // The tree row and the chip over the table.
    await waitFor(() =>
      expect(screen.getAllByText("10.1.2.0/24")).toHaveLength(2)
    )

    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    await waitFor(() => expect(search(router).rail).toBeUndefined())
    expect(screen.queryByRole("tree")).toBeNull()
    expect(search(router).within).toBe("p24")
    fireEvent.click(screen.getByRole("button", { name: "Clear prefix scope" }))
    await waitFor(() => expect(search(router).within).toBeUndefined())
  })

  it("filters on the server and reveals the path to the match", async () => {
    setup("/prefixes?rail=tree")
    await screen.findByRole("treeitem", { name: "10.0.0.0/8" })
    fireEvent.change(screen.getByRole("textbox", { name: "Filter prefixes" }), {
      target: { value: "10.9" },
    })
    // Debounced, then one search request.
    await waitFor(() =>
      expect(calls.some((c) => c.includes("q=10.9"))).toBe(true)
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: "192.168.0.0/16" })
      ).toBeNull()
    )
    const hit = await screen.findByRole("treeitem", { name: "10.9.4.0/24" })
    expect(hit.getAttribute("aria-level")).toBe("2")
    expect(calls.some((c) => c.includes("q=10.9"))).toBe(true)
    // Only the path shows: the /8's other child is not drawn.
    expect(screen.queryByRole("treeitem", { name: "10.1.0.0/16" })).toBeNull()
  })
})
