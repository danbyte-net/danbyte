import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { buildDiagram } from "./diagram/build-diagram"
import type { DiagramOptions } from "./diagram/build-diagram"
import { toDocument } from "./diagram/to-document"
import type { DiagramEdgeData } from "./diagram/types"
import { classifyEdges } from "./edge-semantics"
import { edgeStroke } from "./edge-style"
import {
  NO_TOPO_HIDDEN,
  PROVIDER_NETWORKS,
  applyHidden,
  hiddenOnMap,
} from "./hidden"
import { setHidden } from "@/components/hidden-objects"
import { sizeOf } from "./node-registry"

// Provider networks on the topology (#466): the node a set of circuits
// meets at, and the line from each device (or site card) to it - as the
// API sends them (api/topology_provider.py).

const status = {
  id: "st1",
  name: "Active",
  slug: "active",
  color: "#22c55e",
  text_color: "#000000",
  is_default: false,
}

function device(id: string, name: string, site: string): TopoNode {
  return {
    id: `dev:${id}`,
    type: "device",
    data: {
      device_id: id,
      name,
      status: "active",
      status_mini: status,
      role: { id: "r1", name: "Switch", color: "#0ea5e9" },
      site,
      location: null,
      primary_ip: null,
      interface_count: 48,
      panel: false,
      ports: [{ name: "Gi0/48", kind: "interface" }],
    },
  }
}

const circuitRef = (id: string, cid: string) => ({
  id,
  cid,
  provider: { id: "p1", name: "Telco" },
  type: { id: "t1", name: "MPLS", color: "aa00ff" },
  status,
  commit_rate_kbps: 100_000,
})

const network: TopoNode = {
  id: "pn:pn1",
  type: "provider_network",
  data: {
    kind: "provider_network",
    provider_network_id: "pn1",
    name: "MPLS cloud",
    service_id: "",
    provider: { id: "p1", name: "Telco" },
    circuit_count: 2,
    circuits: [
      { ...circuitRef("c1", "C-1"), site: { id: "s1", name: "Aarhus" } },
      { ...circuitRef("c2", "C-2"), site: { id: "s2", name: "Odense" } },
    ],
  },
}

function line(dev: string, devName: string, c: string, cid: string): TopoEdge {
  return {
    id: `ce:${c}`,
    source: `dev:${dev}`,
    target: "pn:pn1",
    type: "circuit",
    data: {
      circuit: circuitRef(c, cid),
      provider_network: { id: "pn1", name: "MPLS cloud" },
      site: { id: "s1", name: "Aarhus" },
      device: { id: dev, name: devName },
      port: { id: `i-${dev}`, name: "Gi0/48", kind: "interface" },
      color: "aa00ff",
      status: "active",
      status_mini: status,
      via: [],
      pairs: [
        {
          a: `${devName}:Gi0/48`,
          b: `MPLS cloud:${cid}`,
          a_port: "Gi0/48",
          b_port: cid,
          a_id: `i-${dev}`,
          a_kind: "interface",
          b_id: `t-${c}`,
          b_kind: "circuit_termination",
        },
      ],
    },
  }
}

const graph: TopologyGraph = {
  nodes: [
    device("d1", "sw-aarhus", "Aarhus"),
    device("d2", "sw-odense", "Odense"),
    network,
  ],
  edges: [
    line("d1", "sw-aarhus", "c1", "C-1"),
    line("d2", "sw-odense", "c2", "C-2"),
  ],
}

const opts = (o: Partial<DiagramOptions> = {}): DiagramOptions => ({
  mode: "detailed",
  line: "straight",
  colorMode: "type",
  measure: approxMeasure,
  ...o,
})

describe("provider networks on the Diagram", () => {
  it("is a node of its own, the size of a site card", () => {
    const b = buildDiagram(graph, opts())
    const pn = b.nodes.find((n) => n.id === "pn:pn1")!
    expect(pn.type).toBe("provider_network")
    expect(sizeOf(pn)).toEqual({ width: 212, height: 76 })
  })

  it.each(["simple", "detailed"] as const)(
    "draws one named line per circuit to it (%s)",
    (mode) => {
      const b = buildDiagram(graph, opts({ mode }))
      const lines = b.edges.filter(
        (e) => (e.data as DiagramEdgeData).raw?.circuit
      )
      expect(lines).toHaveLength(2)
      for (const e of lines) {
        const d = e.data as DiagramEdgeData
        expect([e.source, e.target]).toContain("pn:pn1")
        expect(d.simple).toBe(true)
        expect(d.labels.mid).toEqual([d.raw!.circuit!.cid])
        // The circuit's colour, whatever the colour mode.
        expect(e.style?.stroke).toBe("#aa00ff")
      }
    }
  )

  it("never folds two circuits into a pair's bundle", () => {
    const twin = line("d1", "sw-aarhus", "c3", "C-3")
    const g = { ...graph, edges: [...graph.edges, twin] }
    const classes = classifyEdges(g, { fold: "pair" })
    expect(classes.map((c) => c.sem)).toEqual(["cable", "cable", "cable"])
  })

  it("wears the circuit's colour under every colour mode", () => {
    const d = line("d1", "x", "c1", "C-1").data!
    for (const mode of ["type", "status", "speed", "cable", "none"] as const)
      expect(edgeStroke(d, mode)).toBe("#aa00ff")
  })
})

describe("provider networks in the exports", () => {
  it("draws the network as a card with its provider, linked back", () => {
    const b = buildDiagram(graph, opts())
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "WAN", generated_at: "2026-11-03T12:00:00Z" },
      measure: approxMeasure,
      origin: "https://danbyte.example",
    })
    const pn = doc.nodes.find((n) => n.id === "pn:pn1")!
    expect(pn.title).toBe("MPLS cloud")
    expect(pn.lines).toEqual(["Telco"])
    expect(pn.link).toBe("https://danbyte.example/provider-networks/pn1")
    const links = doc.links.filter((l) =>
      [l.source.node, l.target.node].includes("pn:pn1")
    )
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.link)).toEqual(
      expect.arrayContaining([
        "https://danbyte.example/circuits/c1",
        "https://danbyte.example/circuits/c2",
      ])
    )
    // The writers take it as any card.
    expect(toSvg(doc)).toContain("MPLS cloud")
    expect(toDrawio([doc])).toContain("MPLS cloud")
  })

  it("keeps each circuit in a Simple export of a Detailed map", () => {
    const twin = line("d1", "sw-aarhus", "c3", "C-3")
    const b = buildDiagram(
      { ...graph, edges: [...graph.edges, twin] },
      opts({ mode: "detailed" })
    )
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "WAN", generated_at: "2026-11-03T12:00:00Z" },
      measure: approxMeasure,
      mode: "simple",
    })
    const links = doc.links.filter(
      (l) => l.target.node === "pn:pn1" || l.source.node === "pn:pn1"
    )
    expect(links).toHaveLength(3)
  })
})

describe("hiding provider networks", () => {
  it("one eye takes the nodes and their lines off", () => {
    const h = setHidden(NO_TOPO_HIDDEN, "kinds", PROVIDER_NETWORKS, true)
    const g = applyHidden(graph, h)
    expect(g.nodes.map((n) => n.id)).toEqual(["dev:d1", "dev:d2"])
    expect(g.edges).toEqual([])
    expect(hiddenOnMap(graph, h)).toBe(1)
  })

  it("a row's eye takes one network off, with its lines", () => {
    const h = setHidden(NO_TOPO_HIDDEN, "devices", "pn:pn1", true)
    const g = applyHidden(graph, h)
    expect(g.nodes).toHaveLength(2)
    expect(g.edges).toEqual([])
  })

  it("a hidden site never takes a network with it", () => {
    const h = setHidden(NO_TOPO_HIDDEN, "sites", "No site", true)
    const g = applyHidden(graph, h)
    expect(g.nodes.map((n) => n.id)).toContain("pn:pn1")
  })
})
