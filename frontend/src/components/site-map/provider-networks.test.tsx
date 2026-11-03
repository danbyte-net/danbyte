// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SiteMapConnection, SiteMapProviderNetwork } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { connectionPaths } from "./connections-layer"
import { LineEnds, ProviderNetworkInspector } from "./inspector"
import { providerNetworkIcon } from "./map-icons"
import { MapObjectsSidebar, NO_HIDDEN } from "./map-sidebar"

// Provider networks on the site map (#466): a marker where a network's
// circuits meet, its panel, its eye in the Objects sidebar, and the lines
// that run to it from each site.

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: vi.fn(() => Promise.resolve({ results: [] })),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)

const network: SiteMapProviderNetwork = {
  id: "pn1",
  name: "MPLS cloud",
  service_id: "SVC-9",
  provider: { id: "p1", name: "Telco" },
  latitude: 55.5,
  longitude: 11,
  site_ids: ["s1", "s2"],
  circuits: [
    {
      id: "c1",
      cid: "C-1",
      site: { id: "s1", name: "Aarhus" },
      type: "MPLS",
      status: { name: "Active", color: "#22c55e" },
      color: "aa00ff",
      commit_rate_kbps: 100_000,
    },
    {
      id: "c2",
      cid: "C-2",
      site: { id: "s2", name: "Odense" },
      type: null,
      status: null,
      color: "",
      commit_rate_kbps: null,
    },
  ],
}

const line = (id: string, site: string): SiteMapConnection => ({
  id: `circuit:${id}`,
  kind: "circuit",
  name: id,
  site_a: { id: site, name: site, latitude: 55, longitude: 12 },
  site_z: { id: "pn:pn1", name: "MPLS cloud", latitude: 55.5, longitude: 11 },
  provider_network: { id: "pn1", name: "MPLS cloud" },
  color: "aa00ff",
  status: null,
  meta: {},
})

/** Inside a real in-memory router: the panel's links are router links. */
async function routed(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/site-map",
    component: () => <>{node}</>,
  })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/$kind/$id",
    component: () => <p>object page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([map, page]),
    history: createMemoryHistory({ initialEntries: ["/site-map"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  await screen.findAllByRole("link")
  return router
}

describe("the provider network panel", () => {
  it("names the provider and lists the circuits, each to its line", async () => {
    const onFocus = vi.fn()
    await routed(
      <ProviderNetworkInspector
        network={network}
        onFocusConnection={onFocus}
        onClose={() => {}}
      />
    )
    expect(screen.getByText("MPLS cloud")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Telco" })).toBeTruthy()
    expect(screen.getByText("SVC-9")).toBeTruthy()
    const list = screen.getByRole("region", { name: "Circuits · 2" })
    expect(within(list).getByText("Aarhus · MPLS · 100M")).toBeTruthy()
    // A status as its pill, never a dot.
    expect(within(list).getByText("Active")).toBeTruthy()
    fireEvent.click(within(list).getByText("C-2"))
    expect(onFocus).toHaveBeenCalledWith("circuit:c2")
    expect(
      screen
        .getByRole("link", { name: /Open provider network/ })
        .getAttribute("href")
    ).toBe("/provider-networks/pn1")
  })

  it("a line's far end links to the network, not to a site", async () => {
    await routed(<LineEnds edge={line("C-1", "s1")} />)
    expect(
      screen.getByRole("link", { name: "MPLS cloud" }).getAttribute("href")
    ).toBe("/provider-networks/pn1")
  })
})

describe("the provider network marker", () => {
  it("is a cloud with the network's name and circuit count", () => {
    const html = providerNetworkIcon(network).options.html as string
    expect(html).toContain("MPLS cloud")
    expect(html).toContain('<span class="sm-count">2</span>')
    expect(html).toContain("lucide-cloud")
    expect(
      providerNetworkIcon(network, { mini: true }).options.html
    ).not.toContain("MPLS cloud")
  })

  it("escapes the name", () => {
    const html = providerNetworkIcon({ ...network, name: "<b>x</b>" }).options
      .html as string
    expect(html).not.toContain("<b>x</b>")
  })

  it("its lines run from each site to the marker", () => {
    const paths = connectionPaths([line("C-1", "s1"), line("C-2", "s2")])
    for (const pts of paths.values()) {
      expect(pts[0]).toEqual([55, 12])
      expect(pts[pts.length - 1]).toEqual([55.5, 11])
    }
  })
})

describe("the Objects sidebar's provider networks", () => {
  function sidebar(hidden = NO_HIDDEN) {
    const onHiddenChange = vi.fn()
    const onSelect = vi.fn()
    const onFocus = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <MapObjectsSidebar
            sites={[]}
            devices={[]}
            markers={[]}
            connections={[]}
            routes={[]}
            regions={[]}
            hidden={hidden}
            onHiddenChange={onHiddenChange}
            selectedRouteId={null}
            selected={null}
            onSelect={onSelect}
            onFocus={onFocus}
            onFocusConnection={vi.fn()}
            onPickRoute={vi.fn()}
            onFocusRegion={vi.fn()}
            providerNetworks={[network]}
          />
        </TooltipProvider>
      </QueryClientProvider>
    )
    return { onHiddenChange, onSelect, onFocus }
  }

  it("lists each network with its eye", () => {
    const { onHiddenChange, onSelect, onFocus } = sidebar()
    expect(screen.getByText("Provider networks")).toBeTruthy()
    fireEvent.click(screen.getByText("MPLS cloud"))
    expect(onFocus).toHaveBeenCalledWith(55.5, 11)
    expect(onSelect).toHaveBeenCalledWith({
      kind: "provider_network",
      id: "pn1",
    })
    fireEvent.click(screen.getByRole("button", { name: "Hide MPLS cloud" }))
    expect(onHiddenChange).toHaveBeenCalledWith({
      ...NO_HIDDEN,
      providers: ["pn1"],
    })
  })

  it("a hidden one stays listed, to bring back", () => {
    const { onHiddenChange } = sidebar({ ...NO_HIDDEN, providers: ["pn1"] })
    fireEvent.click(screen.getByRole("button", { name: "Show MPLS cloud" }))
    expect(onHiddenChange).toHaveBeenCalledWith(NO_HIDDEN)
  })
})
