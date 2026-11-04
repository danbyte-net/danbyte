// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { setHidden } from "@/components/hidden-objects"
import { buildDiagram } from "./diagram/build-diagram"
import type { DiagramOptions } from "./diagram/build-diagram"
import { toDocument } from "./diagram/to-document"
import type { DiagramEdgeData } from "./diagram/types"
import { classifyEdges } from "./edge-semantics"
import { CIRCUIT_DASH, edgeStroke, isSiteCircuit } from "./edge-style"
import { fromFlow } from "./export/from-flow"
import {
  CIRCUITS,
  NO_TOPO_HIDDEN,
  PROVIDER_NETWORKS,
  applyHidden,
} from "./hidden"
import { build } from "./topology-canvas"

// A circuit between two of your sites, both ends cabled to routers: one
// dashed line between the two devices, named by its circuit id - as the
// API sends it (api/topology_provider.py, `cc:<circuit id>`).

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
      role: { id: "r1", name: "PE", color: "#0ea5e9" },
      site,
      location: null,
      primary_ip: null,
      interface_count: 8,
      panel: false,
      ports: [
        { name: "xe-0/0/0", kind: "interface" },
        { name: "ae0", kind: "interface" },
      ],
    },
  }
}

const circuit = {
  id: "c1",
  cid: "MPLS-0001",
  provider: { id: "p1", name: "Telco" },
  type: { id: "t1", name: "MPLS", color: "aa00ff" },
  status,
  commit_rate_kbps: 1_000_000,
}

const end = (side: "A" | "Z", dev: string, name: string, site: string) => ({
  side,
  termination: {
    id: `t${side}`,
    side,
    port_speed_kbps: null,
    upstream_speed_kbps: null,
  },
  site: { id: `s-${site}`, name: site },
  device: { id: dev, name },
  port: { id: `i-${dev}`, name: "xe-0/0/0", kind: "interface" },
  via: [],
})

const line: TopoEdge = {
  id: "cc:c1",
  source: "dev:d1",
  target: "dev:d2",
  type: "circuit",
  data: {
    circuit,
    ends: [
      end("A", "d1", "NSP1-PE2", "nsp1"),
      end("Z", "d2", "NSP2-PE2", "nsp2"),
    ],
    color: "aa00ff",
    status: "active",
    status_mini: status,
    via: [],
    pairs: [
      {
        a: "NSP1-PE2:xe-0/0/0",
        b: "NSP2-PE2:xe-0/0/0",
        a_port: "xe-0/0/0",
        b_port: "xe-0/0/0",
        a_id: "i-d1",
        a_kind: "interface",
        b_id: "i-d2",
        b_kind: "interface",
      },
    ],
  },
}

// A LAG-member cable between the same two routers: never folds the circuit.
const lagCable: TopoEdge = {
  id: "e:cab1:d1:d2",
  source: "dev:d1",
  target: "dev:d2",
  type: "cable",
  data: {
    cable_id: "cab1",
    cable_type: "smf",
    via: [],
    pairs: [
      { a: "NSP1-PE2:ae0", b: "NSP2-PE2:ae0", a_port: "ae0", b_port: "ae0" },
    ],
    lag: {
      a: { id: "lag-a", name: "ae0" },
      b: { id: "lag-b", name: "ae0" },
    },
  },
}

const graph: TopologyGraph = {
  nodes: [device("d1", "NSP1-PE2", "nsp1"), device("d2", "NSP2-PE2", "nsp2")],
  edges: [line, lagCable],
}

const opts = (o: Partial<DiagramOptions> = {}): DiagramOptions => ({
  mode: "detailed",
  line: "straight",
  colorMode: "type",
  measure: approxMeasure,
  ...o,
})

const META = { title: "WAN", generated_at: "2026-11-04T12:00:00Z" }

describe("a circuit between two sites", () => {
  it("is told apart from a line to a provider network", () => {
    expect(isSiteCircuit(line.data)).toBe(true)
    expect(isSiteCircuit({ circuit })).toBe(false)
    expect(isSiteCircuit(lagCable.data)).toBe(false)
  })

  it("is never bundled with a LAG or a pair's cables", () => {
    for (const fold of ["lag", "pair"] as const) {
      const classes = classifyEdges(graph, { fold })
      const c = classes.find((x) => x.id === "cc:c1")!
      expect(c.sem).toBe("cable")
      if (fold === "lag")
        expect(classes.find((x) => x.sem === "lagbundle")).toBeTruthy()
    }
  })

  it.each(["simple", "detailed"] as const)(
    "draws one dashed line named by its cid on the Diagram (%s)",
    (mode) => {
      const b = buildDiagram(graph, opts({ mode }))
      const lines = b.edges.filter(
        (e) => (e.data as DiagramEdgeData).raw?.circuit
      )
      expect(lines).toHaveLength(1)
      const [e] = lines
      expect([e.source, e.target].sort()).toEqual(["dev:d1", "dev:d2"])
      const d = e.data as DiagramEdgeData
      expect(d.labels.mid).toEqual(["MPLS-0001"])
      expect(e.style?.strokeDasharray).toBe(CIRCUIT_DASH)
      expect(e.style?.stroke).toBe("#aa00ff")
    }
  )

  it("wears its type's colour, else its status's, under every mode", () => {
    for (const mode of ["type", "status", "speed", "cable", "none"] as const)
      expect(edgeStroke(line.data, mode)).toBe("#aa00ff")
    const untyped = { ...line.data!, color: "" }
    expect(edgeStroke(untyped, "type")).toBe("#22c55e")
  })

  it("is dashed and labelled on the Hierarchy, port to port", () => {
    const { edges } = build(graph, { colorMode: "cable" })
    const e = edges.find((x) => x.id === "cc:c1")!
    expect(e.style?.strokeDasharray).toBe(CIRCUIT_DASH)
    expect(String(e.label)).toContain("MPLS-0001")
    expect(e.sourceHandle).toMatch(/^xe-0\/0\/0(~|$)/)
    expect(e.targetHandle).toMatch(/^xe-0\/0\/0(~|$)/)
  })

  it("goes card to card on the grouped map", () => {
    const grouped: TopologyGraph = {
      nodes: [
        {
          id: "grp:s1",
          type: "group",
          data: { kind: "site", group_id: "s1", name: "nsp1" } as never,
        },
        {
          id: "grp:s2",
          type: "group",
          data: { kind: "site", group_id: "s2", name: "nsp2" } as never,
        },
      ],
      edges: [
        {
          ...line,
          source: "grp:s1",
          target: "grp:s2",
          data: { ...line.data!, pairs: undefined },
        },
      ],
    }
    const { edges } = build(grouped, { colorMode: "cable" })
    const e = edges.find((x) => x.id === "cc:c1")!
    expect(e.sourceHandle).toMatch(/^n(~|$)/)
    expect(e.targetHandle).toMatch(/^n(~|$)/)
    expect(e.style?.strokeDasharray).toBe(CIRCUIT_DASH)
  })
})

describe("a circuit between two sites in the exports", () => {
  it("draws the dashed line with its cid, linked to the circuit", () => {
    const b = buildDiagram(graph, opts())
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: META,
      measure: approxMeasure,
      origin: "https://danbyte.example",
    })
    const link = doc.links.find(
      (l) => l.link === "https://danbyte.example/circuits/c1"
    )!
    expect(link).toBeTruthy()
    expect(link.dash).toBe(CIRCUIT_DASH)
    expect(link.labels.mid).toEqual(["MPLS-0001"])
    const svg = toSvg(doc)
    expect(svg).toContain(`stroke-dasharray="${CIRCUIT_DASH}"`)
    expect(svg).toContain("MPLS-0001")
    const drawio = toDrawio([doc])
    expect(drawio).toContain(`dashPattern=${CIRCUIT_DASH}`)
    expect(drawio).toContain("MPLS-0001")
  })

  it("keeps it its own line in the Hierarchy export", () => {
    const { nodes, edges } = build(graph, { colorMode: "cable" })
    const doc = fromFlow(nodes, edges, [], {
      meta: META,
      measure: approxMeasure,
      origin: "https://danbyte.example",
    })
    const link = doc.links.find(
      (l) => l.link === "https://danbyte.example/circuits/c1"
    )!
    expect(link.dash).toBe(CIRCUIT_DASH)
    expect(link.labels.mid).toEqual(["MPLS-0001"])
    // The LAG's cable is a line of its own beside it.
    expect(doc.links).toHaveLength(2)
    expect(toSvg(doc)).toContain(`stroke-dasharray="${CIRCUIT_DASH}"`)
  })
})

describe("hiding circuits between sites", () => {
  it("one eye takes every such line off, the cards stay", () => {
    const g = applyHidden(
      graph,
      setHidden(NO_TOPO_HIDDEN, "kinds", CIRCUITS, true)
    )
    expect(g.nodes).toHaveLength(2)
    expect(g.edges.map((e) => e.id)).toEqual([lagCable.id])
  })

  it("Provider networks' eye leaves it alone", () => {
    const g = applyHidden(
      graph,
      setHidden(NO_TOPO_HIDDEN, "kinds", PROVIDER_NETWORKS, true)
    )
    expect(g.edges.map((e) => e.id)).toContain("cc:c1")
  })

  it("its row's eye takes one off", () => {
    const g = applyHidden(
      graph,
      setHidden(NO_TOPO_HIDDEN, "edges", "cc:c1", true)
    )
    expect(g.edges.map((e) => e.id)).toEqual([lagCable.id])
  })
})
