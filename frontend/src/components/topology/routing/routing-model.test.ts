import { describe, expect, it } from "vitest"

import type { RoutingEdge, RoutingRouterData, RoutingTopology } from "@/lib/api"
import { NO_TOPO_HIDDEN } from "../hidden"
import { routingDocument, routingLegendRows } from "./routing-document"
import {
  DEFAULT_LAYERS,
  arrangeByAs,
  asPairColor,
  cardsInside,
  edgeLanes,
  nodeSizes,
  readRoutingDisplay,
  routerLines,
  routingDisplay,
  routingEdgeLabel,
  routingEdgeLook,
  shownRouting,
} from "./routing-model"

/** Fixed-width text, so sizes do not depend on fonts. */
const measure = (text: string, size: number) => text.length * size * 0.6

function router(
  id: string,
  over: Partial<RoutingRouterData> = {}
): RoutingTopology["nodes"][number] {
  return {
    id,
    type: "router",
    data: {
      kind: "device",
      device_id: id.slice(4),
      vm_id: null,
      name: id.slice(4),
      role: { id: "r", name: "Router", slug: "router", color: "#0ea5e9" },
      status_mini: null,
      site: "AMS",
      site_id: "s",
      primary_ip: null,
      router: true,
      router_id: "10.0.0.1",
      asns: [{ asn: 65001, vrf: null }],
      as_group: 65001,
      loopback: "10.255.0.1",
      instances: [],
      ...over,
    },
  }
}

function bgp(
  type: "ebgp" | "ibgp",
  source: string,
  target: string,
  over: Partial<Extract<RoutingEdge, { type: "ebgp" }>["data"]> = {}
): RoutingEdge {
  return {
    id: `${type}:${source}|${target}|`,
    source,
    target,
    type,
    data: {
      kind: type,
      vrf: null,
      address_families: ["ipv4-unicast"],
      a_asn: 65001,
      b_asn: type === "ebgp" ? 65050 : 65001,
      pairs: [],
      sessions: [],
      rr: null,
      one_sided: false,
      ...over,
    },
  }
}

const map: RoutingTopology = {
  nodes: [
    router("dev:r1"),
    router("dev:r2"),
    router("dev:isp", { as_group: 65050, asns: [], router: false }),
    router("dev:ospf-only", { as_group: null, asns: [] }),
  ],
  edges: [
    bgp("ebgp", "dev:r1", "dev:isp", {
      address_families: ["ipv4-unicast", "ipv6-unicast"],
      vrf: "red",
    }),
    bgp("ibgp", "dev:r1", "dev:r2", {
      rr: { reflector: "dev:r1", client: "dev:r2", cluster_id: "1.1.1.1" },
    }),
  ],
  as_groups: [
    {
      id: "as:65001",
      asn: 65001,
      asn_id: null,
      name: "Core",
      nodes: ["dev:r1", "dev:r2"],
    },
    {
      id: "as:65050",
      asn: 65050,
      asn_id: null,
      name: null,
      nodes: ["dev:isp"],
    },
  ],
  meta: {
    layers: {
      ebgp: true,
      ibgp: true,
      ospf: true,
      isis: true,
      static: true,
      circuits: true,
      cables: true,
    },
    requested: ["ebgp", "ibgp", "circuits"],
  },
}

describe("routing display", () => {
  it("reads defaults and keeps only what differs", () => {
    const s = readRoutingDisplay(undefined)
    expect(s.mode).toBe("detailed")
    expect(s.layers).toEqual(DEFAULT_LAYERS)
    expect(s.fields).toEqual(["router_id", "asn", "loopback"])
    expect(routingDisplay(s)).toEqual({ mode: "detailed" })
    const t = readRoutingDisplay({
      mode: "simple",
      layers: { cables: true, bogus: true },
      fields: ["loopback", "role"],
    })
    expect(t.layers.cables).toBe(true)
    // In the vocabulary's order.
    expect(t.fields).toEqual(["role", "loopback"])
    expect(routingDisplay(t)).toEqual({
      mode: "simple",
      layers: { cables: true },
      fields: ["role", "loopback"],
    })
  })
})

describe("cards and lines", () => {
  it("lists the card lines; Simple keeps the AS", () => {
    const d = (map.nodes[0] as { data: RoutingRouterData }).data
    expect(
      routerLines(d, "detailed", ["router_id", "asn", "loopback"]).map(
        (l) => l.text
      )
    ).toEqual(["RID 10.0.0.1", "AS65001", "lo 10.255.0.1"])
    expect(routerLines(d, "simple", ["router_id", "asn"])).toEqual([
      { key: "asn", text: "AS65001" },
    ])
  })

  it("labels eBGP with its ASes and iBGP only when it says something", () => {
    expect(routingEdgeLabel(map.edges[0])).toEqual([
      "AS65001 ⇄ AS65050",
      "v4 · v6 · VRF red",
    ])
    expect(routingEdgeLabel(map.edges[1])).toEqual([
      "v4 · RR client · cluster 1.1.1.1",
    ])
    expect(routingEdgeLabel(bgp("ibgp", "dev:a", "dev:b"))).toEqual([])
  })

  it("draws eBGP thick per AS pair and RR lines with an arrow", () => {
    const e = routingEdgeLook(map.edges[0])
    expect(e.width).toBeGreaterThan(routingEdgeLook(map.edges[1]).width)
    expect(e.stroke).toBe(asPairColor(65050, 65001))
    expect(routingEdgeLook(map.edges[1]).arrow).toBe(true)
  })

  it("sizes a card to its whole name", () => {
    const long = router("dev:x", {
      name: "a-very-long-router-name-at-the-edge",
    })
    const short = router("dev:y", { name: "r1" })
    const sizes = nodeSizes([long, short], "detailed", ["asn"], measure)
    expect(sizes.get("dev:x")!.w).toBeGreaterThan(sizes.get("dev:y")!.w)
  })
})

describe("what is shown", () => {
  it("takes off layers, hidden cards and their lines", () => {
    const off = shownRouting(
      map,
      { ...DEFAULT_LAYERS, ebgp: false },
      NO_TOPO_HIDDEN
    )
    expect(off.edges.map((e) => e.type)).toEqual(["ibgp"])
    const hid = shownRouting(map, DEFAULT_LAYERS, {
      ...NO_TOPO_HIDDEN,
      devices: ["dev:r2"],
    })
    expect(hid.nodes.map((n) => n.id)).not.toContain("dev:r2")
    expect(hid.edges.map((e) => e.type)).toEqual(["ebgp"])
  })
})

describe("Arrange ▸ By AS", () => {
  const sizes = nodeSizes(map.nodes, "detailed", ["asn"], measure)

  it("puts each AS's cards inside its box", () => {
    const { positions, zones } = arrangeByAs(map, sizes)
    expect(zones.map((z) => z.asn)).toEqual([65001, 65050])
    expect(zones[0].label).toBe("AS65001 · Core")
    for (const z of zones) {
      const inside = cardsInside(z, positions)
      const want = map.as_groups.find((g) => g.asn === z.asn)!.nodes
      expect(inside.sort()).toEqual([...want].sort())
    }
    // The card in no AS is placed, outside every box.
    expect(positions["dev:ospf-only"]).toBeDefined()
    expect(
      zones.some((z) => cardsInside(z, positions).includes("dev:ospf-only"))
    ).toBe(false)
  })

  it("keeps an AS box's name and colour and the zones drawn by hand", () => {
    const hand = {
      id: "z1",
      label: "Mine",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      color: null,
    }
    const first = arrangeByAs(map, sizes)
    const renamed = first.zones.map((z) =>
      z.asn === 65001 ? { ...z, label: "Backbone", color: "#ec4899" } : z
    )
    const again = arrangeByAs(map, sizes, { zones: [hand, ...renamed] })
    const box = again.zones.find((z) => z.asn === 65001)!
    expect(box.label).toBe("Backbone")
    expect(box.color).toBe("#ec4899")
    expect(again.zones).toContainEqual(hand)
  })
})

describe("export", () => {
  it("draws the cards, boxes and lines with labels and the RR arrow", () => {
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
        meta: {
          title: "Routing topology",
          generated_at: "2026-11-04T00:00:00Z",
        },
        origin: "https://danbyte.example",
        measure,
      }
    )
    expect(doc.meta.title).toBe("Routing topology")
    expect(doc.nodes).toHaveLength(4)
    expect(doc.nodes[0].link).toMatch(/^https:\/\/danbyte\.example\/devices\//)
    expect(doc.bands.map((b) => b.kind)).toEqual(["zone", "zone"])
    const ebgp = doc.links.find((l) => l.id.startsWith("ebgp"))!
    expect(ebgp.sem).toBe("bgp")
    expect(ebgp.labels.mid).toEqual(["AS65001 ⇄ AS65050", "v4 · v6 · VRF red"])
    expect(doc.links.find((l) => l.id.startsWith("ibgp"))!.arrow).toBe("end")
  })

  it("keys the layers drawn and each AS pair", () => {
    const rows = routingLegendRows(map)
    expect(rows.map((r) => r.label)).toEqual([
      "eBGP",
      "iBGP · RR → client",
      "AS65001 ⇄ AS65050",
    ])
  })

  it("runs parallel lines in lanes", () => {
    const lanes = edgeLanes([
      { id: "a", source: "x", target: "y" },
      { id: "b", source: "y", target: "x" },
      { id: "c", source: "x", target: "z" },
    ])
    expect([lanes.get("a"), lanes.get("b"), lanes.get("c")]).toEqual([
      -0.5, 0.5, 0,
    ])
  })
})
