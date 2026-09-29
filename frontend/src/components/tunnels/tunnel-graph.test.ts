import { describe, expect, it } from "vitest"

import type { TopologyGraph, TunnelTermination } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { TUNNEL_DASH } from "@/components/topology/edge-style"
import { buildDiagram } from "@/components/topology/diagram/build-diagram"
import { cardContent } from "@/components/topology/diagram/card-fields"
import { toDocument } from "@/components/topology/diagram/to-document"
import type { DiagramEdgeData } from "@/components/topology/diagram/types"
import { ringPositions, tunnelDeviceIds, tunnelGraph } from "./tunnel-graph"
import type { TunnelCardData } from "./tunnel-graph"

// A tunnel's map: its ends as Diagram cards with their role as the pill, a
// dashed line per hub ↔ spoke or peer ↔ peer carrying the interface names
// and outside addresses, a hub's spokes as one breakout.

let seq = 0
function dev(
  device: string,
  role: TunnelTermination["role"] = "peer",
  outside: string | null = null,
  port = "tun0"
): TunnelTermination {
  seq += 1
  return {
    id: `t${seq}`,
    role,
    role_display: role[0].toUpperCase() + role.slice(1),
    interface: {
      id: `i${seq}`,
      name: port,
      device: { id: device, name: `${device}-fw` },
    },
    vm_interface: null,
    outside_ip: outside ? { id: `ip${seq}`, ip_address: outside } : null,
    created_at: "",
    updated_at: "",
  }
}

function vm(id: string, role: TunnelTermination["role"] = "spoke") {
  const t = dev("unused", role, "192.0.2.40", "wg0")
  return {
    ...t,
    interface: null,
    vm_interface: { id: `vi-${id}`, name: "wg0", vm: { id, name: `${id}-vm` } },
  }
}

const tunnel = (terminations: TunnelTermination[]) => ({
  id: "tun-1",
  name: "HQ-VPN",
  terminations,
})

/** The Topology API's card for device `hq`: a role colour and its IP. */
const cards: TopologyGraph = {
  nodes: [
    {
      id: "dev:hq",
      type: "device",
      data: {
        name: "hq-fw",
        device_id: "hq",
        role: { name: "Firewall", color: "f59e0b" },
        card: {
          fields: ["primary_ip"],
          source: "tenant",
          values: {
            primary_ip: { id: "p", address: "10.0.0.1", cidr: "10.0.0.1/24" },
          },
        },
      },
    },
  ],
  edges: [],
  meta: {
    card: { fields: ["primary_ip"], source: "tenant", uses_monitor: false },
  },
}

const hubAndSpoke = () =>
  tunnel([
    dev("hq", "hub", "198.51.100.1"),
    dev("b1", "spoke", "203.0.113.1"),
    dev("b2", "spoke", "203.0.113.2"),
    vm("v1"),
  ])

describe("tunnelGraph", () => {
  it("draws a hub's links to every spoke, sharing the hub's end", () => {
    const t = hubAndSpoke()
    const { graph, direction, positions } = tunnelGraph(t, cards)
    expect(direction).toBe("TB")
    expect(positions).toBeUndefined()
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "dev:hq",
      "dev:b1",
      "dev:b2",
      "vm:v1",
    ])
    expect(graph.edges.map((e) => [e.source, e.target])).toEqual([
      ["dev:hq", "dev:b1"],
      ["dev:hq", "dev:b2"],
      ["dev:hq", "vm:v1"],
    ])
    const hub = t.terminations[0].id
    for (const e of graph.edges) {
      expect(e.type).toBeUndefined()
      expect(e.data).toMatchObject({
        cable_id: hub,
        cable_label: "HQ-VPN",
        tunnel: { id: "tun-1", name: "HQ-VPN" },
      })
    }
    expect(graph.edges[0].data!.pairs).toEqual([
      {
        a: "hq-fw:tun0",
        b: "b1-fw:tun0",
        a_port: "tun0",
        b_port: "tun0",
        a_id: t.terminations[0].interface!.id,
        a_kind: "interface",
        b_id: t.terminations[1].interface!.id,
        b_kind: "interface",
        a_outside: "198.51.100.1",
        b_outside: "203.0.113.1",
      },
    ])
    expect(graph.edges[2].data!.pairs![0]).toMatchObject({
      b: "v1-vm:wg0",
      b_id: "vi-v1",
      b_kind: "vminterface",
    })
    expect(graph.meta).toBe(cards.meta)
  })

  it("gives each card its end's role as the pill, over its own lines", () => {
    const { graph } = tunnelGraph(hubAndSpoke(), cards)
    const [hq, b1, , v1] = graph.nodes
    // The device's own card: role colour, lines, and the role pill first.
    expect(hq.data.role?.color).toBe("f59e0b")
    const c = cardContent(hq.data)
    expect(c.lines.map((l) => l.text)).toEqual(["10.0.0.1"])
    expect(c.pill).toMatchObject({ kind: "status", text: "Hub" })
    // Colourless: it draws as the neutral badge, never a derived colour.
    expect(hq.data.status_mini).toMatchObject({ name: "Hub", color: "" })
    // Out of the viewer's scope (not in the API's answer): name and pill.
    expect(b1.data).toMatchObject({ name: "b1-fw", device_id: "b1" })
    expect(b1.data.role).toBeUndefined()
    expect(cardContent(b1.data).pill?.text).toBe("Spoke")
    // A VM: a neutral card that says what it is, and knows its VM.
    expect(v1.data.role).toBeUndefined()
    expect(v1.data.device_id).toBeUndefined()
    expect((v1.data as TunnelCardData).vm_id).toBe("v1")
    expect(cardContent(v1.data).lines.map((l) => l.text)).toEqual([
      "Virtual machine",
    ])
  })

  it("joins two peers with one line, side by side", () => {
    const { graph, direction, positions } = tunnelGraph(
      tunnel([dev("a"), dev("b")])
    )
    expect(direction).toBe("LR")
    expect(positions).toBeUndefined()
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0].data!.cable_id).toBeUndefined()
    expect(graph.meta).toBeUndefined()
  })

  it("meshes three peers or more, pinned round a ring", () => {
    const { graph, positions } = tunnelGraph(
      tunnel([dev("a"), dev("b"), dev("c"), dev("d")])
    )
    expect(graph.edges).toHaveLength(6)
    expect(graph.edges.every((e) => !e.data!.cable_id)).toBe(true)
    expect(Object.keys(positions!)).toEqual([
      "dev:a",
      "dev:b",
      "dev:c",
      "dev:d",
    ])
    // The first at the top, clockwise.
    const [x, y] = positions!["dev:a"]
    expect(x).toBe(0)
    expect(y).toBeLessThan(0)
    expect(positions!["dev:b"][0]).toBeGreaterThan(0)
  })

  it("draws hubs only (or spokes only) as peers", () => {
    const { graph, direction } = tunnelGraph(
      tunnel([dev("a", "hub"), dev("b", "hub")])
    )
    expect(direction).toBe("LR")
    expect(graph.edges).toHaveLength(1)
  })

  it("keeps two ends on one device on one card, both roles in its pill", () => {
    const { graph } = tunnelGraph(
      tunnel([dev("hq", "hub"), dev("hq", "spoke", null, "tun1"), dev("b")])
    )
    expect(graph.nodes.map((n) => n.id)).toEqual(["dev:hq", "dev:b"])
    expect(graph.nodes[0].data.status_mini?.name).toBe("Hub · Spoke")
    // No line from a card to itself.
    expect(graph.edges.map((e) => [e.source, e.target])).toEqual([
      ["dev:hq", "dev:b"],
    ])
  })

  it("asks for each device's card once", () => {
    expect(
      tunnelDeviceIds(tunnel([dev("b"), dev("a"), dev("b"), vm("v")]))
    ).toEqual(["a", "b"])
  })
})

describe("ringPositions", () => {
  it("spaces more cards on a wider ring, never a tight one", () => {
    const r = (n: number) =>
      Math.hypot(
        ...ringPositions(Array.from({ length: n }, (_, i) => `n${i}`)).n0
      )
    expect(r(2)).toBe(r(3))
    expect(r(4)).toBeGreaterThan(r(3))
    expect(r(12)).toBeGreaterThan(r(4))
  })
})

describe("the tunnel map on the Diagram", () => {
  const build = (t: ReturnType<typeof tunnel>) => {
    const m = tunnelGraph(t, cards)
    return buildDiagram(m.graph, {
      mode: "detailed",
      line: "elbow",
      colorMode: "cable",
      direction: m.direction,
      ...(m.positions ? { positions: m.positions } : {}),
      measure: approxMeasure,
    })
  }

  it("draws a hub's spokes as one breakout, dashed, with no name chip", () => {
    const b = build(hubAndSpoke())
    const junctions = b.nodes.filter((n) => n.type === "junction")
    expect(junctions).toHaveLength(1)
    const links = b.edges.filter((e) => e.type === "link")
    const data = (e: (typeof links)[number]) => e.data as DiagramEdgeData
    const trunk = links.find((e) => data(e).fan?.role === "trunk")!
    const legs = links.filter((e) => data(e).fan?.role === "leg")
    expect(legs).toHaveLength(3)
    for (const e of links) {
      expect(e.style?.strokeDasharray).toBe(TUNNEL_DASH)
      expect(data(e).labels.mid ?? []).toEqual([])
    }
    // The hub's outside address on its trunk, each spoke's on its leg.
    expect(data(trunk).labels.ends).toEqual([{ a: ["198.51.100.1"] }])
    expect(legs.map((e) => data(e).labels.ends?.[0]?.b)).toEqual([
      ["203.0.113.1"],
      ["203.0.113.2"],
      ["192.0.2.40"],
    ])
  })

  it("carries both ends' addresses on a point-to-point line", () => {
    const b = build(
      tunnel([
        dev("a", "peer", "198.51.100.1"),
        dev("b", "peer", "203.0.113.9"),
      ])
    )
    const [e] = b.edges.filter((x) => x.type === "link")
    const d = e.data as DiagramEdgeData
    expect(e.style?.strokeDasharray).toBe(TUNNEL_DASH)
    expect(d.labels.mid ?? []).toEqual([])
    const ends = d.labels.ends![0]
    expect([...(ends.a ?? []), ...(ends.b ?? [])].sort()).toEqual([
      "198.51.100.1",
      "203.0.113.9",
    ])
  })

  it("keeps a ring's cards where they were pinned", () => {
    const t = tunnel([dev("a"), dev("b"), dev("c")])
    const b = build(t)
    const at = tunnelGraph(t, cards).positions!
    for (const n of b.nodes.filter((x) => x.type === "card"))
      expect([n.position.x, n.position.y]).toEqual(at[n.id])
  })

  it("links every line, and the split point, back to the tunnel in a file", () => {
    const b = build(hubAndSpoke())
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "HQ-VPN", generated_at: "2026-09-29T12:00:00Z" },
      origin: "https://danbyte.example",
      measure: approxMeasure,
    })
    expect(doc.links.length).toBeGreaterThan(0)
    for (const l of doc.links) {
      expect(l.link).toBe("https://danbyte.example/tunnels/tun-1")
      expect(l.dash).toBe(TUNNEL_DASH)
      expect(l.cable).toBeUndefined()
    }
    expect(doc.junctions).toHaveLength(1)
    expect(doc.junctions![0].link).toBe("https://danbyte.example/tunnels/tun-1")
    expect(doc.junctions![0].cable).toBeUndefined()
    expect(toSvg(doc)).toContain(`stroke-dasharray="${TUNNEL_DASH}"`)
    const trunk = doc.links.find((l) => l.labels.aIps?.length)
    expect(trunk?.labels.aIps?.map((x) => x.text)).toEqual(["198.51.100.1"])
  })
})
