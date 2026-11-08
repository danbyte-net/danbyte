// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it } from "vitest"

import { isMapSearch } from "@/components/topology/views-list"
import { Route as ListRoute } from "./topology.index"

// The map moved to /topology/map and /topology became the list of saved
// views: every old map link - a view, a site, a device, a tab - still opens
// the map with everything it named; a bare /topology is the list.

afterEach(cleanup)

async function mount(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const layout = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => <Outlet />,
  })
  const list = createRoute({
    getParentRoute: () => layout,
    path: "/",
    beforeLoad: (ctx) =>
      (ListRoute.options.beforeLoad as (c: unknown) => void)(ctx),
    component: () => <p>views list</p>,
  })
  const map = createRoute({
    getParentRoute: () => layout,
    path: "/map",
    component: () => <p>the map</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([list, map])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  await act(async () => {
    render(<RouterProvider router={router as never} />)
    await router.load()
  })
  return router
}

describe("/topology", () => {
  it("is the list when bare", async () => {
    const router = await mount("/topology")
    expect(router.state.location.pathname).toBe("/topology")
  })

  it("keeps the list's own search", async () => {
    const router = await mount("/topology?search=dc1")
    expect(router.state.location.pathname).toBe("/topology")
  })

  it.each([
    "/topology?view=v1",
    "/topology?site=s1",
    "/topology?device=d1&depth=2",
    "/topology?tab=hierarchy&site=s1&color=speed",
    "/topology?view=none&tab=diagram&devices=a,b",
  ])("sends %s on to the map with everything it named", async (url) => {
    const router = await mount(url)
    expect(router.state.location.pathname).toBe("/topology/map")
    const want = new URLSearchParams(url.split("?")[1])
    const got = router.state.location.search as Record<string, unknown>
    for (const [k, v] of want) expect(String(got[k])).toBe(v)
  })
})

describe("isMapSearch", () => {
  it("is any key the list does not own", () => {
    expect(isMapSearch({})).toBe(false)
    expect(isMapSearch({ search: "x" })).toBe(false)
    expect(isMapSearch({ view: "v1" })).toBe(true)
    expect(isMapSearch({ q: "core" })).toBe(true)
  })
})
