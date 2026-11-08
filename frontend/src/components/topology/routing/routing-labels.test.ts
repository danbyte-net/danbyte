import { describe, expect, it } from "vitest"

import type { RoutingEdge, RoutingRouterData, RoutingTopology } from "@/lib/api"
import type { Rect } from "../diagram/types"
import { routingDocument, routingLegendRows } from "./routing-document"
import {
  chipSize,
  lineEnds,
  placeRoutingLabels,
  routingLabels,
  spotPoint,
} from "./routing-labels"
import type { LabelSpot } from "./routing-labels"
import { arrangeByAs, edgeLanes, nodeSizes } from "./routing-model"

/** Fixed-width text, so sizes do not depend on fonts. */
const measure = (text: string, size: number) => text.length * size * 0.6

function router(
  name: string,
  role: string,
  over: Partial<RoutingRouterData> = {}
): RoutingTopology["nodes"][number] {
  return {
    id: `dev:${name}`,
    type: "router",
    data: {
      kind: "device",
      device_id: name,
      vm_id: null,
      name,
      role: { id: role, name: role, slug: role, color: "#0ea5e9" },
      status_mini: null,
      site: null,
      site_id: null,
      primary_ip: null,
      router: true,
      router_id: null,
      asns: [{ asn: 65100, vrf: null }],
      as_group: 65100,
      loopback: null,
      instances: [],
      ...over,
    },
  }
}

const igpEnd = (node: string) => ({
  node,
  id: `${node}-if`,
  instance_id: `${node}-isis`,
  process: null,
  interface: "e1",
  interface_id: null,
  vm_interface_id: null,
  network_type: null,
  passive: false,
  bfd: false,
  bfd_profile: null,
  authentication: null,
  keychain: null,
  level: "2" as const,
})

function session(
  spine: string,
  leaf: string,
  over: { vrf?: string } = {}
): RoutingEdge {
  return {
    id: `ibgp:dev:${spine}|dev:${leaf}|${over.vrf ?? ""}`,
    source: `dev:${spine}`,
    target: `dev:${leaf}`,
    type: "ibgp",
    data: {
      kind: "ibgp",
      vrf: over.vrf ?? null,
      address_families: ["l2vpn-evpn"],
      a_asn: 65100,
      b_asn: 65100,
      pairs: [],
      sessions: [],
      rr: {
        reflector: `dev:${spine}`,
        client: `dev:${leaf}`,
        cluster_id: "10.255.0.0",
      },
      one_sided: false,
    },
  }
}

function adjacency(leaf: string, spine: string, metric = 10): RoutingEdge {
  return {
    id: `isis:dev:${leaf}|dev:${spine}||2`,
    source: `dev:${leaf}`,
    target: `dev:${spine}`,
    type: "isis",
    data: {
      vrf: null,
      vrf_id: null,
      level: "2",
      levels: ["2", "2"],
      metric: [metric, metric],
      links: [
        {
          via: "subnet",
          cable_id: null,
          subnet: "10.0.0.0/31",
          a: igpEnd(`dev:${leaf}`),
          b: igpEnd(`dev:${spine}`),
        },
      ],
    },
  }
}

const LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]
const SPINES = ["spine1", "spine2"]

/** The 4-leaf, 2-spine fabric: every leaf an RR client of both spines
 * (evpn, one cluster) and an IS-IS L2 adjacency to each. */
function fabric(
  tweak: (e: RoutingEdge) => RoutingEdge = (e) => e
): RoutingTopology {
  const nodes = [
    ...LEAVES.map((n) => router(n, "leaf")),
    ...SPINES.map((n) => router(n, "spine")),
  ]
  const edges = LEAVES.flatMap((l) =>
    SPINES.flatMap((s) => [session(s, l), adjacency(l, s)])
  ).map(tweak)
  return {
    nodes,
    edges,
    as_groups: [
      {
        id: "g",
        asn: 65100,
        asn_id: null,
        name: "Fabric",
        nodes: nodes.map((n) => n.id),
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
        cables: false,
      },
      requested: ["ibgp", "isis"],
      vrf: "all",
      vrfs: [],
    },
    checks: [],
  }
}

/** The fabric laid out as the tab does: leaves over spines. */
function layout(map: RoutingTopology) {
  const sizes = nodeSizes(map.nodes, "detailed", ["asn"], measure)
  const { positions, zones } = arrangeByAs(map, sizes, {
    roleOrder: ["leaf", "spine"],
  })
  const rects = new Map<string, Rect>()
  for (const [id, [x, y]] of Object.entries(positions)) {
    const s = sizes.get(id)!
    rects.set(id, { x: x - s.w / 2, y: y - s.h / 2, w: s.w, h: s.h })
  }
  return { positions, zones, rects, lanes: edgeLanes(map.edges) }
}

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Each placed label's box, as drawn. */
function chipBoxes(
  map: RoutingTopology,
  own: ReadonlyMap<string, readonly string[]>,
  spots: ReadonlyMap<string, LabelSpot | null>,
  rects: ReadonlyMap<string, Rect>,
  lanes: ReadonlyMap<string, number>
): Map<string, Rect> {
  const ends = lineEnds(map.edges, rects, lanes)
  const out = new Map<string, Rect>()
  for (const [id, spot] of spots) {
    if (!spot) continue
    const { a, b } = ends.get(id)!
    const p = spotPoint(a, b, spot)
    const { w, h } = chipSize(own.get(id)!, measure)
    out.set(id, { x: p.x - w / 2, y: p.y - h / 2, w, h })
  }
  return out
}

function expectNoOverlaps(
  boxes: ReadonlyMap<string, Rect>,
  rects: ReadonlyMap<string, Rect>
) {
  const list = [...boxes]
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++)
      expect(
        overlap(list[i][1], list[j][1]),
        `${list[i][0]} on ${list[j][0]}`
      ).toBe(false)
    for (const [card, r] of rects)
      expect(overlap(list[i][1], r), `${list[i][0]} on ${card}`).toBe(false)
  }
}

describe("routing line labels", () => {
  it("says what every line of a box shares once, in the legend", () => {
    const map = fabric()
    const said = routingLabels(map)
    expect([...said.own.values()].every((l) => l.length === 0)).toBe(true)
    expect(said.full.get("ibgp:dev:spine1|dev:leaf1|")).toEqual([
      "evpn · RR client · cluster 10.255.0.0",
    ])
    expect(said.summaries.map((s) => [s.type, s.text, s.edges.length])).toEqual(
      [
        ["ibgp", "RR clients of spine1, spine2 · evpn · cluster 10.255.0.0", 8],
        ["isis", "L2 · metric 10", 8],
      ]
    )
    const rows = routingLegendRows(map).map((r) => r.label)
    expect(rows).toContain(
      "AS65100 · iBGP · RR clients of spine1, spine2 · evpn · cluster 10.255.0.0"
    )
    expect(rows).toContain("AS65100 · IS-IS · L2 · metric 10")
  })

  it("keeps a label only on the lines that differ", () => {
    const map = fabric((e) =>
      e.id === "isis:dev:leaf3|dev:spine2||2"
        ? adjacency("leaf3", "spine2", 50)
        : e
    )
    const said = routingLabels(map)
    const labelled = [...said.own].filter(([, l]) => l.length)
    expect(labelled).toEqual([
      ["isis:dev:leaf3|dev:spine2||2", ["L2 · metric 50"]],
    ])
    const { rects, lanes } = layout(map)
    const spots = placeRoutingLabels(map.edges, said.own, rects, lanes, measure)
    expect(spots.get("isis:dev:leaf3|dev:spine2||2")).not.toBeNull()
  })

  it("never puts a label on another label or a card, every line labelled", () => {
    const map = fabric()
    const { rects, lanes } = layout(map)
    // Nothing said once: every line asks for its whole label.
    const own = routingLabels(map).full
    const spots = placeRoutingLabels(map.edges, own, rects, lanes, measure)
    expect(spots.size).toBe(16)
    const boxes = chipBoxes(map, own, spots, rects, lanes)
    expect(boxes.size).toBeGreaterThan(0)
    expectNoOverlaps(boxes, rects)
  })

  it("puts a session's and an adjacency's labels each on its own side", () => {
    const map = fabric()
    const { rects, lanes } = layout(map)
    const own = routingLabels(map).full
    const spots = placeRoutingLabels(map.edges, own, rects, lanes, measure)
    const ses = spots.get("ibgp:dev:spine1|dev:leaf1|")
    const adj = spots.get("isis:dev:leaf1|dev:spine1||2")
    // In lanes either side of the middle, never on top of each other.
    expect(lanes.get("ibgp:dev:spine1|dev:leaf1|")).not.toBe(0)
    for (const s of [ses, adj]) if (s) expect(s.off).not.toBe(0)
  })

  it("leaves a label with no room off the line, to show on hover", () => {
    // Every pair of cards close together, with long labels on each line.
    const map = fabric((e) =>
      e.type === "ibgp"
        ? session(e.source.slice(4), e.target.slice(4), {
            vrf: `TENANT-${e.id.length}-${e.source}-${e.target}`,
          })
        : e
    )
    const said = routingLabels(map)
    const rects = new Map<string, Rect>()
    map.nodes.forEach((n, i) =>
      rects.set(n.id, {
        x: (i % 3) * 90,
        y: Math.floor(i / 3) * 60,
        w: 70,
        h: 30,
      })
    )
    const lanes = edgeLanes(map.edges)
    const spots = placeRoutingLabels(map.edges, said.own, rects, lanes, measure)
    const dropped = [...spots].filter(([, s]) => s === null).map(([id]) => id)
    expect(dropped.length).toBeGreaterThan(0)
    for (const id of dropped)
      expect(said.full.get(id)!.length).toBeGreaterThan(0)
    expectNoOverlaps(chipBoxes(map, said.own, spots, rects, lanes), rects)
  })

  it("prints each label where the canvas puts it", () => {
    const map = fabric((e) =>
      e.id === "isis:dev:leaf3|dev:spine2||2"
        ? adjacency("leaf3", "spine2", 50)
        : e
    )
    const { positions, zones, rects, lanes } = layout(map)
    const spots = placeRoutingLabels(
      map.edges,
      routingLabels(map).own,
      rects,
      lanes,
      measure
    )
    const doc = routingDocument(
      {
        map,
        centres: positions,
        zones,
        mode: "detailed",
        fields: ["asn"],
        lanes,
      },
      {
        meta: { title: "Routing topology", generated_at: "2026-11-08" },
        measure,
      }
    )
    const id = "isis:dev:leaf3|dev:spine2||2"
    const link = doc.links.find((l) => l.id === id)!
    const spot = spots.get(id)!
    expect(link.labels.mid).toEqual(["L2 · metric 50"])
    expect(link.labels.midAt ?? 0.5).toBe(spot.t)
    expect(link.labels.midOff ?? 0).toBe(spot.off)
    // The lines said once carry no label of their own.
    expect(
      doc.links.filter((l) => l.id !== id).every((l) => !l.labels.mid)
    ).toBe(true)
  })
})
