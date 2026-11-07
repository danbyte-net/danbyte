// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it } from "vitest"

import type { RoutingEdge, RoutingSessionRow } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RoutingEdgePanel, RoutingNodePanel } from "./routing-panels"

// A Routing line's panel lists every session on it - peer group, policies
// in and out as links to the policy, max-prefix, BFD profile, the timers
// and the instance's RPKI caches - and a router's its router ID, ASes and
// loopback. No status is ever a dot.

afterEach(cleanup)
window.scrollTo = () => undefined

async function show(panel: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => <>{panel}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([map]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return screen.findByRole("complementary")
}

const session: RoutingSessionRow = {
  id: "s1",
  numid: 7,
  name: null,
  node: "dev:r1",
  vrf: null,
  local_asn: 65001,
  remote_asn: 65050,
  local_address: "192.0.2.0",
  remote_address: "192.0.2.1",
  interface: null,
  status_mini: null,
  peer_group: { id: "pg", name: "UPSTREAM" },
  import_policy: { id: "pin", name: "IN" },
  export_policy: { id: "pout", name: "OUT" },
  address_families: [
    {
      afi_safi: "ipv4-unicast",
      activate: true,
      import_policy: { id: "pin", name: "IN" },
      export_policy: { id: "pout", name: "OUT" },
      maximum_prefix: 1000,
      maximum_prefix_threshold: 75,
      maximum_prefix_restart: 5,
      maximum_prefix_warning_only: false,
      route_reflector_client: null,
    },
  ],
  maximum_prefix: 1000,
  maximum_prefix_threshold: 75,
  maximum_prefix_restart: 5,
  maximum_prefix_warning_only: false,
  bfd: true,
  bfd_profile: { id: "bfd", name: "fast" },
  keepalive: 10,
  hold_time: 30,
  route_reflector_client: false,
  cluster_id: null,
  rpki_caches: [{ id: "c1", name: "rpki1" }],
}

const ebgp: RoutingEdge = {
  id: "ebgp:dev:r1|dev:isp|",
  source: "dev:r1",
  target: "dev:isp",
  type: "ebgp",
  data: {
    kind: "ebgp",
    vrf: null,
    address_families: ["ipv4-unicast"],
    a_asn: 65001,
    b_asn: 65050,
    pairs: [],
    sessions: [session],
    rr: null,
    one_sided: true,
  },
}

const names: Record<string, string> = { "dev:r1": "r1", "dev:isp": "isp-edge" }

describe("RoutingEdgePanel", () => {
  it("lists the session with links to its policies", async () => {
    const aside = await show(
      <RoutingEdgePanel
        edge={ebgp}
        name={(id) => names[id] ?? "?"}
        onClose={() => {}}
      />
    )
    expect(within(aside).getByText("r1 ⇄ isp-edge")).toBeTruthy()
    expect(within(aside).getByText("One side only")).toBeTruthy()
    const section = within(aside).getByRole("region", {
      name: "r1 → 192.0.2.1",
    })
    const link = (text: string) =>
      within(section).getByRole("link", { name: text }).getAttribute("href")
    expect(link("UPSTREAM")).toBe("/bgp-peer-groups/pg")
    expect(link("IN")).toBe("/routing-policies/pin")
    expect(link("OUT")).toBe("/routing-policies/pout")
    expect(link("fast")).toBe("/bfd-profiles/bfd")
    expect(link("rpki1")).toBe("/rpki-caches/c1")
    expect(within(section).getByText("10 / 30 s")).toBeTruthy()
    expect(within(section).getByText("1000 · 75% · restart 5 min")).toBeTruthy()
    expect(
      within(aside).getByRole("link", { name: /Open session/ })
    ).toBeTruthy()
    expect(aside.querySelector(".rounded-full")).toBeNull()
  })

  it("shows a family whose max-prefix details differ", async () => {
    const af = {
      ...session.address_families[0],
      maximum_prefix_restart: null,
      maximum_prefix_warning_only: true,
    }
    const aside = await show(
      <RoutingEdgePanel
        edge={{
          ...ebgp,
          data: {
            ...ebgp.data,
            sessions: [{ ...session, address_families: [af] }],
          },
        }}
        name={(id) => names[id] ?? "?"}
        onClose={() => {}}
      />
    )
    expect(
      within(aside).getByText("· max 1000 · 75% · warning only", {
        exact: false,
      })
    ).toBeTruthy()
  })
})

describe("RoutingNodePanel", () => {
  it("shows the router's ID, ASes and loopback", async () => {
    const aside = await show(
      <RoutingNodePanel
        node={{
          id: "dev:r1",
          type: "router",
          data: {
            kind: "device",
            device_id: "r1",
            vm_id: null,
            name: "r1",
            role: { id: "r", name: "Router", slug: "router", color: "#0ea5e9" },
            status_mini: null,
            site: "AMS",
            site_id: "s",
            primary_ip: null,
            router: true,
            router_id: "10.255.0.1",
            asns: [
              { asn: 65001, vrf: null },
              { asn: 65100, vrf: "red" },
            ],
            as_group: 65001,
            loopback: "10.255.0.1",
            instances: [
              {
                kind: "bgp",
                id: "i1",
                vrf: null,
                router_id: "10.255.0.1",
                asn: 65001,
              },
              { kind: "ospf", id: "o1", vrf: null, router_id: null },
            ],
          },
        }}
        onClose={() => {}}
        onFocus={() => {}}
      />
    )
    expect(within(aside).getByText("AS65001, AS65100 (red)")).toBeTruthy()
    expect(within(aside).getByText("BGP AS65001")).toBeTruthy()
    expect(within(aside).getByText("OSPF")).toBeTruthy()
    expect(
      within(aside).getByRole("link", { name: /Open device/ })
    ).toBeTruthy()
  })
})
