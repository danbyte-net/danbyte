import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoLinkSubnet, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { fanoutGraph } from "../__fixtures__/fanout-graph"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import {
  END_MAX,
  MID_MAX,
  fanLabelSets,
  linkLabelSet,
  linkSubnet,
  orientPair,
} from "./link-labels"
import type { CablePair, DiagramEdgeData } from "./types"

// Link labels: the subnet two ends share mid-line, each end's full address
// at that end - oriented like the drawn edge, per member of a bundle, per
// leg of a breakout - and nothing where the addresses are missing.

const v4 = (n: number, len = 31): TopoLinkSubnet => ({
  cidr: `10.0.${n}.0/${len}`,
  family: 4,
  a: `10.0.${n}.0`,
  b: `10.0.${n}.1`,
})
const v6 = (n: number, len = 127): TopoLinkSubnet => ({
  cidr: `2001:db8:${n}::/${len}`,
  family: 6,
  a: `2001:db8:${n}::`,
  b: `2001:db8:${n}::1`,
})

const pair = (subnets?: TopoLinkSubnet[], extra: Partial<CablePair> = {}) =>
  ({
    a: "x:e1",
    b: "y:e1",
    a_port: "e1",
    b_port: "e1",
    ...(subnets ? { subnets } : {}),
    ...extra,
  }) as CablePair

describe("linkSubnet", () => {
  it("counts IPv4 /24 to /31 and IPv6 /64 to /127 as a link", () => {
    for (const c of ["10.0.0.0/31", "10.0.0.0/30", "10.0.0.0/24"])
      expect(linkSubnet(c), c).toBe(true)
    for (const c of ["10.0.0.0/23", "10.0.0.0/16", "10.0.0.1/32", "10.0.0.0"])
      expect(linkSubnet(c), c).toBe(false)
    for (const c of ["2001:db8::/64", "2001:db8::/127"])
      expect(linkSubnet(c), c).toBe(true)
    for (const c of ["2001:db8::/48", "2001:db8::1/128"])
      expect(linkSubnet(c), c).toBe(false)
  })
})

describe("linkLabelSet", () => {
  it("labels a /31: the subnet mid-line, each end's full address", () => {
    expect(linkLabelSet([[pair([v4(1)])]])).toEqual({
      mid: ["10.0.1.0/31"],
      ends: [{ a: ["10.0.1.0"], b: ["10.0.1.1"] }],
    })
  })

  it("stacks a dual-stack link, IPv4 first", () => {
    expect(linkLabelSet([[pair([v6(1), v4(1)])]])).toEqual({
      mid: ["10.0.1.0/31", "2001:db8:1::/127"],
      ends: [
        {
          a: ["10.0.1.0", "2001:db8:1::"],
          b: ["10.0.1.1", "2001:db8:1::1"],
        },
      ],
    })
  })

  it("leaves a subnet larger than /24 (or /64) unlabelled", () => {
    const set = linkLabelSet([[pair([v4(1, 16), v6(1, 48)])]])
    expect(set.mid).toEqual([])
    expect(set.ends).toEqual([{}])
  })

  it("gives nothing, and no error, without addresses", () => {
    expect(linkLabelSet([[pair()]])).toEqual({ mid: [], ends: [{}] })
    expect(linkLabelSet([[pair([])]])).toEqual({ mid: [], ends: [{}] })
    // A half-filled row (no b address) is passed over.
    const odd = { ...v4(1), b: undefined } as unknown as TopoLinkSubnet
    expect(linkLabelSet([[pair([odd])]])).toEqual({ mid: [], ends: [{}] })
  })

  it("draws only what the Labels setting asks for", () => {
    const p = [[pair([v4(1)])]]
    expect(linkLabelSet(p, ["ip"]).mid).toEqual([])
    expect(linkLabelSet(p, ["subnet"]).ends).toEqual([{}])
    expect(linkLabelSet(p, [])).toEqual({ mid: [], ends: [{}] })
  })

  it("shows a LAG's address once, on the member nearest the middle", () => {
    // Three members, each reporting the aggregate's subnet.
    const lag = [pair([v4(7)]), pair([v4(7)]), pair([v4(7)])]
    const set = linkLabelSet(lag.map((p) => [p]))
    expect(set.mid).toEqual(["10.0.7.0/31"])
    expect(set.ends).toEqual([{}, { a: ["10.0.7.0"], b: ["10.0.7.1"] }, {}])
  })

  it("labels each member of a bundle with its own subnet", () => {
    const set = linkLabelSet([[pair([v4(1)])], [pair([v4(2)])]])
    expect(set.mid).toEqual(["10.0.1.0/31", "10.0.2.0/31"])
    expect(set.ends).toEqual([
      { a: ["10.0.1.0"], b: ["10.0.1.1"] },
      { a: ["10.0.2.0"], b: ["10.0.2.1"] },
    ])
  })

  it("folds a Simple line's cables into one set, and caps it", () => {
    const many = [1, 2, 3, 4, 5].map((n) => pair([v4(n)]))
    const set = linkLabelSet([many])
    expect(set.mid).toHaveLength(MID_MAX)
    expect(set.mid.at(-1)).toBe("+2")
    expect(set.ends[0].a).toHaveLength(END_MAX)
    expect(set.ends[0].a!.at(-1)).toBe("+3")
  })
})

describe("a tunnel's end addresses", () => {
  it("puts each end's outside address after its interface, IPv4 first", () => {
    const p = pair(undefined, {
      a_outside: "198.51.100.1",
      b_outside: "2001:db8::9",
    })
    expect(linkLabelSet([[p]])).toEqual({
      mid: [],
      ends: [{ a: ["198.51.100.1"], b: ["2001:db8::9"] }],
    })
    // Addresses off: none; no outside address: nothing at that end.
    expect(linkLabelSet([[p]], ["port"]).ends).toEqual([{}])
    expect(linkLabelSet([[pair(undefined, { b_outside: null })]])).toEqual({
      mid: [],
      ends: [{}],
    })
  })

  it("keeps a hub's address on the trunk, each spoke's on its leg", () => {
    const hub = (b: string) =>
      pair(undefined, { a_outside: "198.51.100.1", b_outside: b })
    const sets = fanLabelSets(
      [hub("203.0.113.1"), hub("203.0.113.2")],
      [[0], [1]]
    )
    expect(sets.trunk.ends).toEqual([{ a: ["198.51.100.1"] }])
    expect(sets.legs.map((l) => l.ends)).toEqual([
      [{ b: ["203.0.113.1"] }],
      [{ b: ["203.0.113.2"] }],
    ])
  })
})

describe("orientPair", () => {
  it("trades every end field on a flipped edge", () => {
    const p = pair([v4(1)], {
      a_id: "ia",
      b_id: "ib",
      a_end: "A",
      b_end: "B",
      a_ips: ["10.0.1.0/31"],
      b_ips: ["10.0.1.1/31"],
      a_outside: "198.51.100.1",
      b_outside: null,
    })
    const f = orientPair(p, true)
    expect(f).toMatchObject({
      a_id: "ib",
      b_id: "ia",
      a_end: "B",
      b_end: "A",
      a_ips: ["10.0.1.1/31"],
      b_ips: ["10.0.1.0/31"],
      a_outside: null,
      b_outside: "198.51.100.1",
    })
    expect(f.subnets![0]).toMatchObject({ a: "10.0.1.1", b: "10.0.1.0" })
    expect(orientPair(p, false)).toBe(p)
  })
})

describe("fanLabelSets", () => {
  const trunkPairs = [pair([v4(1)]), pair([v4(2)]), pair([v4(3)])]

  it("puts a subnet on each leg, the shared port's addresses on the trunk", () => {
    const sets = fanLabelSets(trunkPairs, [[0], [1], [2]])
    expect(sets.legs.map((l) => l.mid)).toEqual([
      ["10.0.1.0/31"],
      ["10.0.2.0/31"],
      ["10.0.3.0/31"],
    ])
    expect(sets.legs.map((l) => l.ends)).toEqual([
      [{ b: ["10.0.1.1"] }],
      [{ b: ["10.0.2.1"] }],
      [{ b: ["10.0.3.1"] }],
    ])
    expect(sets.trunk).toEqual({
      mid: [],
      ends: [{ a: ["10.0.1.0", "10.0.2.0", "10.0.3.0"] }],
    })
  })

  it("moves a subnet every leg shares onto the trunk, once", () => {
    const lan = { ...v4(9, 29) }
    const shared = [0, 1, 2].map((i) =>
      pair([{ ...lan, a: "10.0.9.1", b: `10.0.9.${i + 2}` }])
    )
    const sets = fanLabelSets(shared, [[0], [1], [2]])
    expect(sets.trunk.mid).toEqual(["10.0.9.0/29"])
    expect(sets.trunk.ends).toEqual([{ a: ["10.0.9.1"] }])
    for (const l of sets.legs) expect(l.mid).toEqual([])
    expect(sets.legs.map((l) => l.ends[0].b)).toEqual([
      ["10.0.9.2"],
      ["10.0.9.3"],
      ["10.0.9.4"],
    ])
  })
})

// ── Through the Diagram build ──────────────────────────────────────────

const HUB = "dev:00000000-0000-4000-8000-00000000000f"
const leaf = (i: number) => `dev:00000000-0000-4000-8000-00000000000${i}`

/** A hub with three leaves. Every leaf sorts before the hub, so the
 * payload sends each edge leaf → hub and the Diagram flips it hub → leaf. */
function hubGraph(extra: TopoEdge[] = []): TopologyGraph {
  const nodes = [HUB, leaf(1), leaf(2), leaf(3)].map((id) => ({
    id,
    type: "device" as const,
    data: {
      name: id === HUB ? "hub" : `leaf${id.at(-1)}`,
      device_id: id.slice(4),
      role: { name: "R", color: "#0ea5e9" },
    },
  }))
  const edges: TopoEdge[] = [1, 2, 3].map((i) => {
    // `a` is the leaf's end.
    const p: CablePair = {
      a: `leaf${i}:eth0`,
      b: `hub:Ethernet1/${i}`,
      a_port: "eth0",
      b_port: `Ethernet1/${i}`,
      a_end: "B",
      b_end: "A",
      subnets: [
        {
          cidr: `10.0.${i}.0/31`,
          family: 4,
          a: `10.0.${i}.1`,
          b: `10.0.${i}.0`,
        },
      ],
    }
    return {
      id: `e:c${i}:${leaf(i).slice(4)}:${HUB.slice(4)}`,
      source: leaf(i),
      target: HUB,
      type: "cable",
      data: { cable_id: `c${i}`, pairs: [p] },
    }
  })
  return { nodes, edges: [...edges, ...extra] }
}

const build = (graph: TopologyGraph, o: Partial<DiagramOptions> = {}) =>
  buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })

const dataOf = (e: { data?: unknown }) => e.data as DiagramEdgeData

describe("labels on the Diagram", () => {
  for (const mode of ["detailed", "simple"] as const)
    it(`${mode}: keeps A and B right after the hub → leaf flip`, () => {
      const b = build(hubGraph(), { mode })
      const links = b.edges.filter((e) => e.type === "link")
      expect(links).toHaveLength(3)
      for (const e of links) {
        // Flipped: the hub is the source now, and its address is `a`.
        expect(e.source).toBe(HUB)
        const i = Number(e.target.at(-1))
        const d = dataOf(e)
        expect(d.labels.mid).toEqual([`10.0.${i}.0/31`])
        expect(d.labels.ends).toEqual([
          { a: [`10.0.${i}.0`], b: [`10.0.${i}.1`] },
        ])
      }
    })

  it("adds a LAG's subnet under its bundle chip, its address once", () => {
    const lagEdge = (k: number): TopoEdge => ({
      id: `e:l${k}:${leaf(1).slice(4)}:${HUB.slice(4)}`,
      source: leaf(1),
      target: HUB,
      type: "cable",
      data: {
        cable_id: `l${k}`,
        lag: { a: { id: "ae-l", name: "ae0" }, b: { id: "ae-h", name: "Po1" } },
        pairs: [
          {
            a: `leaf1:et${k}`,
            b: `hub:Ethernet2/${k}`,
            a_port: `et${k}`,
            b_port: `Ethernet2/${k}`,
            subnets: [
              {
                cidr: "10.9.0.0/31",
                family: 4,
                a: "10.9.0.1",
                b: "10.9.0.0",
                a_via: "ae0",
                b_via: "Po1",
              },
            ],
          },
        ],
      },
    })
    const b = build(hubGraph([lagEdge(1), lagEdge(2)]))
    const bundle = b.edges.find((e) => dataOf(e).sem === "lagbundle")!
    const d = dataOf(bundle)
    expect(d.labels.mid).toEqual(["Po1 ⇄ ae0 · 2x", "10.9.0.0/31"])
    const shown = (d.labels.ends ?? []).filter((x) => x.a || x.b)
    expect(shown).toEqual([{ a: ["10.9.0.0"], b: ["10.9.0.1"] }])
    expect(d.labels.ends).toHaveLength(2)
  })

  it("labels a breakout per leg, and the shared port on its trunk", () => {
    const withIps: TopologyGraph = {
      ...fanoutGraph,
      edges: fanoutGraph.edges.map((e) => ({
        ...e,
        data: {
          ...e.data,
          pairs: e.data!.pairs!.map((p, i) => ({
            ...p,
            subnets: [
              {
                cidr: `10.${e.id.length % 7}.${i}.0/31`,
                family: 4 as const,
                a: `10.${e.id.length % 7}.${i}.0`,
                b: `10.${e.id.length % 7}.${i}.1`,
              },
            ],
          })),
        },
      })),
    }
    const b = build(withIps)
    const fan = b.edges.filter((e) => dataOf(e).fan)
    const trunk = fan.find((e) => dataOf(e).fan!.role === "trunk")!
    const legs = fan.filter((e) => dataOf(e).fan!.role === "leg")
    expect(legs).toHaveLength(5)
    for (const l of legs) {
      const d = dataOf(l)
      expect(d.labels.mid).toHaveLength(1)
      expect(d.labels.ends![0].a).toBeUndefined()
      expect(d.labels.ends![0].b).toHaveLength(1)
    }
    // The trunk keeps the cable's chip and carries the port's addresses.
    expect(dataOf(trunk).labels.mid).toEqual(["TEST · cat5e"])
    expect(dataOf(trunk).labels.ends![0].a!.length).toBeGreaterThan(0)
  })

  it("draws no port names with Ports off, and no labels without addresses", () => {
    const plain = build(hubGraph(), { labels: ["subnet", "ip"] })
    for (const e of plain.edges.filter((x) => x.type === "link")) {
      const d = dataOf(e)
      expect(d.labels.noPorts).toBe(true)
      for (const p of d.plan!) {
        expect(p.a).toBeUndefined()
        expect(p.b).toBeUndefined()
      }
    }
    const bare = hubGraph()
    for (const e of bare.edges) for (const p of e.data!.pairs!) delete p.subnets
    for (const e of build(bare).edges.filter((x) => x.type === "link")) {
      const d = dataOf(e)
      expect(d.labels.mid ?? []).toEqual([])
      expect(d.labels.ends).toBeUndefined()
      expect(d.labels.noPorts).toBeUndefined()
    }
  })
})
