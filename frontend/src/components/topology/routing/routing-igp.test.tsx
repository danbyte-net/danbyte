// @vitest-environment jsdom
import { createRef } from "react"
import {
  act,
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

import type {
  RoutingCheck,
  RoutingEdge,
  RoutingIgpEnd,
  RoutingTopology,
} from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NO_TOPO_HIDDEN } from "../hidden"
import { RoutingCanvas } from "./routing-canvas"
import type { RoutingCanvasHandle } from "./routing-canvas"
import { RoutingChecksChip } from "./routing-checks"
import { vrfOptions } from "./routing-display"
import { routingDocument, routingLegendRows } from "./routing-document"
import {
  DEFAULT_LAYERS,
  ISIS_COLOR,
  OSPF_COLOR,
  arrangeByAs,
  edgeLanes,
  isFlagged,
  layerOf,
  nodeSizes,
  problemsOf,
  readRoutingDisplay,
  readVrf,
  routingDisplay,
  routingEdgeLabel,
  routingEdgeLook,
  routingEdgeTitle,
  shownRouting,
} from "./routing-model"
import { RoutingEdgePanel } from "./routing-panels"

// The Routing tab's OSPF, IS-IS and static layers: how their lines look and
// read, their panels (interfaces, costs, BFD, the keychain's name), the VRF
// picker's tables, the Checks chip and the exports, draw.io a layer each.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
afterEach(cleanup)
window.scrollTo = () => undefined

const measure = (text: string, size: number) => text.length * size * 0.6

const router = (id: string) => ({
  id: `dev:${id}`,
  type: "router" as const,
  data: {
    kind: "device" as const,
    device_id: id,
    vm_id: null,
    name: id,
    role: null,
    status_mini: null,
    site: null,
    site_id: null,
    primary_ip: null,
    router: true,
    router_id: null,
    asns: [],
    as_group: null,
    loopback: null,
    instances: [],
  },
})

function end(node: string, over: Partial<RoutingIgpEnd> = {}): RoutingIgpEnd {
  return {
    node,
    id: `${node}-port`,
    instance_id: `${node}-inst`,
    process: "1",
    interface: "e1",
    interface_id: `${node}-e1`,
    vm_interface_id: null,
    network_type: null,
    passive: false,
    bfd: false,
    bfd_profile: null,
    authentication: null,
    keychain: null,
    ...over,
  }
}

const ospf: RoutingEdge = {
  id: "ospf:dev:r1|dev:r2||0|v2",
  source: "dev:r1",
  target: "dev:r2",
  type: "ospf",
  data: {
    vrf: null,
    vrf_id: null,
    version: 2,
    area: "0",
    areas: ["0", "0"],
    cost: [10, 20],
    links: [
      {
        via: "cable",
        cable_id: "cab1",
        subnet: null,
        a: end("dev:r1", {
          area: "0",
          cost: 10,
          bfd: true,
          bfd_profile: { id: "bfd", name: "fast" },
          authentication: "md5",
          keychain: { id: "kc", name: "OSPF-KEYS" },
          hello: 10,
          dead: 40,
          mtu: 1500,
        }),
        b: end("dev:r2", {
          area: "0",
          cost: 20,
          hello: 5,
          dead: 40,
          mtu: 1500,
        }),
      },
    ],
    problems: ["ospf_timers"],
  },
}

const isis: RoutingEdge = {
  id: "isis:dev:r1|dev:r2||2",
  source: "dev:r1",
  target: "dev:r2",
  type: "isis",
  data: {
    vrf: "red",
    vrf_id: "v",
    level: "2",
    levels: ["2", "1-2"],
    metric: [10, 10],
    links: [
      {
        via: "subnet",
        cable_id: null,
        subnet: "10.0.0.0/31",
        a: end("dev:r1", { level: "2", metric: 10 }),
        b: end("dev:r2", { level: "1-2", metric: 10 }),
      },
    ],
    problems: [],
  },
}

const statics: RoutingEdge = {
  id: "static:dev:r1|dev:r3|",
  source: "dev:r1",
  target: "dev:r3",
  type: "static",
  data: {
    vrf: null,
    vrf_id: null,
    count: 30,
    routes: [
      {
        id: "sr1",
        numid: 1,
        prefix: "10.100.0.0/16",
        next_hop: "10.0.0.2",
        distance: null,
      },
    ],
    problems: [],
  },
}

const check: RoutingCheck = {
  id: `${ospf.id}#0`,
  kind: "ospf_timers",
  edge: ospf.id,
  layer: "ospf",
  title: "r1 ⇄ r2",
  text: "Hello 10 ⇄ 5 s on r1 e1 ⇄ r2 e1",
}

const map: RoutingTopology = {
  nodes: [router("r1"), router("r2"), router("r3")],
  edges: [ospf, isis, statics],
  as_groups: [],
  meta: {
    layers: { ...DEFAULT_LAYERS, cables: true },
    requested: ["ospf", "isis", "static"],
    vrf: "all",
    vrfs: [{ id: "v", name: "red", color: "#ef4444" }],
  },
  checks: [check],
}

describe("IGP and static lines", () => {
  it("are layers of their own", () => {
    expect([ospf, isis, statics].map(layerOf)).toEqual([
      "ospf",
      "isis",
      "static",
    ])
    const off = shownRouting(
      map,
      { ...DEFAULT_LAYERS, isis: false },
      NO_TOPO_HIDDEN
    )
    expect(off.edges.map((e) => e.type)).toEqual(["ospf", "static"])
  })

  it("read their area, level, metric and route count", () => {
    expect(routingEdgeLabel(ospf)).toEqual(["area 0", "cost 10 ⇄ 20"])
    expect(
      routingEdgeLabel({
        ...ospf,
        data: { ...ospf.data, area: null, areas: ["0", "1"], cost: [5, 5] },
      })
    ).toEqual(["area 0 ⇄ 1"])
    expect(routingEdgeLabel(isis)).toEqual(["L2 · metric 10 · VRF red"])
    expect(routingEdgeLabel(statics)).toEqual(["30 routes"])
    expect(routingEdgeTitle(statics, (id) => id.slice(4))).toBe(
      "r1 → r3 · Static"
    )
  })

  it("draw dashed per IGP and an arrow to the next hop", () => {
    expect(routingEdgeLook(ospf)).toMatchObject({
      stroke: OSPF_COLOR,
      dash: "6 4",
    })
    expect(routingEdgeLook(isis).stroke).toBe(ISIS_COLOR)
    expect(routingEdgeLook(isis).dash).not.toBe(routingEdgeLook(ospf).dash)
    expect(routingEdgeLook(statics).arrow).toBe(true)
    expect(problemsOf(ospf)).toEqual(["ospf_timers"])
  })
})

describe("VRF and Checks settings", () => {
  it("read and save the table and the chip", () => {
    const id = "0b5e2a4c-1f2d-4e5f-8a9b-0c1d2e3f4a5b"
    // Nothing picked (a view saved before the picker) is every table.
    expect(readVrf(undefined)).toBe("all")
    expect(readVrf("red")).toBe("all")
    expect(readVrf("global")).toBe("global")
    expect(readVrf(id.toUpperCase())).toBe(id)
    const old = readRoutingDisplay({ mode: "simple" })
    expect(old.vrf).toBe("all")
    expect(routingDisplay(old)).toEqual({ mode: "simple" })
    const s = readRoutingDisplay({ vrf: id, checks: true })
    expect([s.vrf, s.checks]).toEqual([id, true])
    expect(routingDisplay(s)).toEqual({
      mode: "detailed",
      vrf: id,
      checks: true,
    })
    expect(routingDisplay({ ...old, vrf: "global" }).vrf).toBe("global")
    expect(routingDisplay(readRoutingDisplay({}))).toEqual({ mode: "detailed" })
  })

  it("offers every table, Global and the map's VRFs", () => {
    expect(vrfOptions(map.meta.vrfs!, "all").map((o) => o.name)).toEqual([
      "All tables",
      "Global",
      "red",
    ])
    // A view's VRF with no line on this map is still the one picked.
    expect(vrfOptions([], "x").map((o) => o.value)).toEqual([
      "all",
      "global",
      "x",
    ])
  })
})

describe("RoutingChecksChip", () => {
  it("lists the items and picks a line", () => {
    const onPick = vi.fn()
    render(<RoutingChecksChip checks={[check]} onPick={onPick} />)
    fireEvent.click(screen.getByRole("button", { name: /Checks/ }))
    fireEvent.click(screen.getByText("Hello/dead mismatch"))
    expect(onPick).toHaveBeenCalledWith(check)
  })
})

async function show(panel: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => <>{panel}</>,
  })
  const r = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <RouterProvider router={r as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return screen.findByRole("complementary")
}

const names = (id: string) => id.slice(4)

describe("IGP and static panels", () => {
  it("an OSPF line lists both interfaces, costs, BFD and the keychain", async () => {
    const aside = await show(
      <RoutingEdgePanel edge={ospf} name={names} onClose={() => {}} />
    )
    expect(within(aside).getByText("r1 ⇄ r2")).toBeTruthy()
    expect(within(aside).getByText("10 ⇄ 20")).toBeTruthy()
    expect(within(aside).getByText("Hello/dead mismatch")).toBeTruthy()
    const link = (text: string) =>
      within(aside).getByRole("link", { name: text }).getAttribute("href")
    expect(link("OSPF-KEYS")).toBe("/routing-keychains/kc")
    expect(link("fast")).toBe("/bfd-profiles/bfd")
    expect(link("Cable")).toBe("/cables/cab1")
    expect(aside.querySelector(".rounded-full")).toBeNull()
  })

  it("an IS-IS line its level and subnet", async () => {
    const aside = await show(
      <RoutingEdgePanel edge={isis} name={names} onClose={() => {}} />
    )
    expect(within(aside).getByText("L2")).toBeTruthy()
    expect(within(aside).getByText("10.0.0.0/31")).toBeTruthy()
  })

  it("a static line its routes, capped", async () => {
    const aside = await show(
      <RoutingEdgePanel edge={statics} name={names} onClose={() => {}} />
    )
    expect(
      within(aside).getByRole("link", { name: "10.100.0.0/16" })
    ).toBeTruthy()
    expect(within(aside).getByText("and 29 more")).toBeTruthy()
  })
})

describe("exports", () => {
  const sizes = nodeSizes(map.nodes, "detailed", ["asn"], measure)
  const { positions, zones } = arrangeByAs(map, sizes)
  const doc = routingDocument(
    {
      map,
      centres: positions,
      zones,
      mode: "detailed",
      fields: ["asn"],
      lanes: edgeLanes(map.edges),
    },
    {
      meta: { title: "Routing topology", generated_at: "2026-11-04" },
      origin: "https://danbyte.example",
      measure,
    }
  )

  it("draws each line in its look on its layer", () => {
    const by = (prefix: string) =>
      doc.links.find((l) => l.id.startsWith(prefix))!
    expect(by("ospf").dash).toBe("6 4")
    expect(by("ospf").labels.mid).toEqual(["area 0", "cost 10 ⇄ 20"])
    expect(by("static").arrow).toBe("end")
    expect(by("static").link).toBe("https://danbyte.example/static-routes/sr1")
    expect([by("ospf").layer, by("isis").layer, by("static").layer]).toEqual([
      "OSPF",
      "IS-IS",
      "Static",
    ])
  })

  it("keys the new layers in the legend", () => {
    expect(routingLegendRows(map).map((r) => r.label)).toEqual([
      "OSPF",
      "IS-IS",
      "Static → next hop",
    ])
  })

  it("gives draw.io a layer per routing layer", () => {
    const xml = toDrawio([doc])
    for (const name of ["OSPF", "IS-IS", "Static"])
      expect(xml).toMatch(
        new RegExp(`<mxCell id="layer-\\d+" value="${name}" parent="0"/>`)
      )
  })
})

describe("the canvas", () => {
  it("haloes a line a Checks item names, only with the chip on", () => {
    const off = readRoutingDisplay(undefined)
    const on = readRoutingDisplay({ checks: true })
    expect(isFlagged(ospf, off)).toBe(false)
    expect(isFlagged(ospf, on)).toBe(true)
    expect(isFlagged(isis, on)).toBe(false)
  })

  it("exports its IGP and static lines", async () => {
    const ref = createRef<RoutingCanvasHandle>()
    const props = {
      map,
      roleOrder: [],
      fitKey: "k",
      matchedIds: null,
      onArrange: vi.fn(),
      onZonesChange: vi.fn(),
      onSelectNode: vi.fn(),
      onSelectEdge: vi.fn(),
      onOpenNode: vi.fn(),
      onCanvasClick: vi.fn(),
      onNodeContext: vi.fn(),
      onZoneContext: vi.fn(),
      onEdgeContext: vi.fn(),
      onPaneContext: vi.fn(),
    }
    render(
      <div style={{ width: 800, height: 600 }}>
        <RoutingCanvas
          ref={ref}
          {...props}
          settings={readRoutingDisplay({ checks: true })}
        />
      </div>
    )
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByText("r3")).toBeTruthy()
    const out = ref.current!.document({
      area: "all",
      meta: { title: "Routing topology", generated_at: "2026-11-04" },
    })!
    expect(out.links.map((l) => l.layer).sort()).toEqual([
      "IS-IS",
      "OSPF",
      "Static",
    ])
  })
})
