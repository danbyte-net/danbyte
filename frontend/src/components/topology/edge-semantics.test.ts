import { describe, expect, it } from "vitest"
import type { Edge } from "@xyflow/react"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { classifyEdges, orientHubToLeaf } from "./edge-semantics"

const node = (id: string) =>
  ({ id, type: "device", data: { name: id } }) as TopoNode

const cable = (id: string, s: string, t: string, lag?: [string, string]) =>
  ({
    id,
    source: s,
    target: t,
    type: "cable",
    data: {
      cable_id: id,
      pairs: [{ a: "A", b: "B", a_port: `${id}a`, b_port: `${id}b` }],
      ...(lag
        ? {
            lag: {
              a: { id: lag[0], name: lag[0] },
              b: { id: lag[1], name: lag[1] },
            },
          }
        : {}),
    },
  }) as TopoEdge

const graph = (edges: TopoEdge[]): TopologyGraph => ({
  nodes: ["a", "b", "c"].map(node),
  edges,
})

describe("classifyEdges", () => {
  const edges = [
    cable("c1", "a", "b", ["po1", "po2"]),
    cable("c2", "a", "b", ["po1", "po2"]),
    cable("c3", "a", "c"),
    cable("c4", "a", "c"),
    { id: "g", source: "b", target: "c", type: "ghost", data: {} },
    cable("gone", "a", "missing"),
  ] as TopoEdge[]

  it("folds aggregates after the unfolded edges, in payload order", () => {
    const out = classifyEdges(graph(edges), { fold: "lag" })
    expect(out.map((c) => `${c.sem}:${c.id}`)).toEqual([
      "cable:c3",
      "cable:c4",
      "ghost:g",
      "lagbundle:lag:a>b|po1|po2",
    ])
  })

  it("folds every cable between a device pair in the Flat view", () => {
    const out = classifyEdges(graph(edges), { fold: "pair" })
    expect(out.map((c) => `${c.sem}:${c.id}`)).toEqual([
      "ghost:g",
      "bundle:f:a>b",
      "bundle:f:a>c",
    ])
    const one = classifyEdges(graph([cable("c1", "a", "b")]), { fold: "pair" })
    expect(one).toMatchObject([{ sem: "cable", id: "f:a>b", byPair: true }])
  })

  it("drops the cables leaving a hidden origin port", () => {
    const out = classifyEdges(graph(edges), {
      fold: "none",
      originId: "a",
      hiddenPorts: new Set(["c3a"]),
    })
    expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c4", "g"])
  })
})

describe("orientHubToLeaf", () => {
  it("makes the busier device the source and reports the flips", () => {
    const e = (id: string, source: string, target: string, sem = "cable") =>
      ({
        id,
        source,
        target,
        sourceHandle: `${id}s`,
        targetHandle: `${id}t`,
        data: { sem },
      }) as Edge
    const { edges, flipped } = orientHubToLeaf([
      e("1", "leaf", "hub"),
      e("2", "hub", "srv"),
      e("3", "other", "hub"),
      // Non-routable edges count toward degree but never flip.
      e("4", "x", "hub", "bgp"),
    ])
    expect([...flipped].sort()).toEqual(["1", "3"])
    expect(edges[0]).toMatchObject({
      source: "hub",
      target: "leaf",
      sourceHandle: "1t",
      targetHandle: "1s",
    })
    expect(edges[1]).toMatchObject({ source: "hub", target: "srv" })
    expect(edges[3]).toMatchObject({ source: "x", target: "hub" })
  })
})
