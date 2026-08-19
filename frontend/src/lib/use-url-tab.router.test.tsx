// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it } from "vitest"

import { useUrlSubTab, useUrlTab } from "./use-url-tab"

// A real (in-memory) router, because half of this behaviour is the router's:
// two params written independently, a push per write, and the fallback when a
// param is junk. Router v1.170 *preserves* params a route never validated, so
// these cases pin that the sub-tab works either way and that the allow-list -
// not `validateSearch` - is what makes a junk `?sub=` fall back.

const TABS = ["overview", "components"] as const
const SUBS = ["interfaces", "console", "power", "hardware"] as const
type Tab = (typeof TABS)[number]
type Sub = (typeof SUBS)[number]

function Detail() {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const [sub, setSub] = useUrlSubTab<Sub>("interfaces", SUBS)
  return (
    <div>
      <p data-testid="tab">{tab}</p>
      <p data-testid="sub">{sub}</p>
      <button onClick={() => setSub("hardware")}>go-sub-hardware</button>
      <button onClick={() => setTab("overview")}>go-tab-overview</button>
    </div>
  )
}

/** `declareSub: false` mimics the pre-fix route - `tab` validated, `sub` not. */
function makeRouter(url: string, declareSub = true) {
  const root = createRootRoute()
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id",
    component: Detail,
    validateSearch: (s: Record<string, unknown>): Record<string, unknown> => ({
      ...(typeof s.tab === "string" && TABS.includes(s.tab as Tab)
        ? { tab: s.tab }
        : {}),
      ...(declareSub && typeof s.sub === "string" && SUBS.includes(s.sub as Sub)
        ? { sub: s.sub }
        : {}),
    }),
  })
  return createRouter({
    routeTree: root.addChildren([detail]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
}

async function mount(url: string, declareSub = true) {
  const router = makeRouter(url, declareSub)
  render(<RouterProvider router={router as never} />)
  await screen.findByTestId("sub")
  return router
}

const shown = () => ({
  tab: screen.getByTestId("tab").textContent,
  sub: screen.getByTestId("sub").textContent,
})

const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }))

/** Wait for the router's navigation to land in the rendered output. */
const settled = (want: { tab: string; sub: string }) =>
  waitFor(() => expect(shown()).toEqual(want))

afterEach(cleanup)

describe("?tab= and ?sub= on one page", () => {
  it("deep-links both levels at once", async () => {
    await mount("/devices/1?tab=components&sub=power")
    expect(shown()).toEqual({ tab: "components", sub: "power" })
  })

  it("falls back to the defaults for junk values", async () => {
    await mount("/devices/1?tab=nope&sub=nonsense")
    expect(shown()).toEqual({ tab: "overview", sub: "interfaces" })
  })

  it("reads and validates ?sub= even on a route that never declared it", async () => {
    await mount("/devices/1?tab=components&sub=power", false)
    expect(shown()).toEqual({ tab: "components", sub: "power" })
    cleanup()
    await mount("/devices/1?tab=components&sub=nonsense", false)
    expect(shown()).toEqual({ tab: "components", sub: "interfaces" })
  })

  it("keeps the sub-tab across a top-level tab change, and back/forward walks both", async () => {
    const router = await mount("/devices/1?tab=components&sub=power")

    click("go-sub-hardware")
    await settled({ tab: "components", sub: "hardware" })
    expect(router.state.location.searchStr).toContain("tab=components")
    expect(router.state.location.searchStr).toContain("sub=hardware")

    // Leaving Components for the default tab writes `tab` away but keeps
    // `sub`, so coming back lands on the same sub-tab.
    click("go-tab-overview")
    await settled({ tab: "overview", sub: "hardware" })
    expect(router.state.location.searchStr).not.toContain("tab=")
    expect(router.state.location.searchStr).toContain("sub=hardware")

    // Each write pushed an entry, so back returns to the previous selection.
    router.history.back()
    await settled({ tab: "components", sub: "hardware" })
    router.history.back()
    await settled({ tab: "components", sub: "power" })
  })
})
