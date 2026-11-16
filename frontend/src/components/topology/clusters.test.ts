import { describe, expect, it } from "vitest"

import type { TopoCluster, TopoNode, TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { devId, fabricGraph } from "./__fixtures__/fabric-graph"
import { clusterCardOf, collapseClusters } from "./clusters"
import { buildDiagram } from "./diagram/build-diagram"
import type { ChassisNodeData, DiagramOptions } from "./diagram/build-diagram"
import { chassisSpecs, frameOfData } from "./diagram/chassis"
import { toDocument } from "./diagram/to-document"
import type { DiagramEdgeData } from "./diagram/types"

// Group clusters (#517): a cluster's hosts as one card with their cables
// folded per far card and counted, or - opened - a frame round them the
// way a virtual chassis stacks; and the files drawing either.

const CL = "5d1e7b20-3c4a-4f6e-9b81-2a7c0e4d9f17"
const CL2 = "8e2f1c39-6b5d-4a70-8c92-3b8d1f5e0a28"
const VC = "7a0c3e6d-9f2b-4e5d-a813-6b9c2e5f8a99"
const leaf1 = devId("leaf1")
const leaf2 = devId("leaf2")
const spine1 = devId("spine1")
const spine2 = devId("spine2")

/** The payload's `clusters`, as `_with_clusters` counts it: cables only. */
function payload(
  graph: TopologyGraph,
  of: Partial<Record<string, { id: string; name: string }>>
): TopologyGraph {
  const groups = new Map<string, TopoCluster>()
  const nodes: TopoNode[] = graph.nodes.map((n) => {
    const c = of[n.id]
    if (!c) return n
    const g = groups.get(c.id) ?? {
      id: c.id,
      name: c.name,
      frame: `cl:${c.id}`,
      members: [],
      member_count: 0,
      inner: 0,
      links: [],
    }
    g.members.push(n.id)
    g.member_count += 1
    groups.set(c.id, g)
    return { ...n, data: { ...n.data, cluster: c } }
  })
  for (const e of graph.edges) {
    if (e.type !== "cable") continue
    const a = of[e.source]?.id
    const b = of[e.target]?.id
    if (a && a === b) {
      groups.get(a)!.inner += 1
      continue
    }
    for (const [cid, far] of [
      [a, e.target],
      [b, e.source],
    ] as const) {
      if (!cid) continue
      const links = groups.get(cid)!.links
      let row = links.find((r) => r.node === far)
      if (!row) {
        row = { node: far, cable_count: 0, edges: [] }
        links.push(row)
      }
      row.cable_count += 1
      row.edges.push(e.id)
    }
  }
  return { ...graph, nodes, clusters: [...groups.values()] }
}

const prod = { id: CL, name: "prod" }
const graph = payload(fabricGraph, { [leaf1]: prod, [leaf2]: prod })
const cables = (from: string, to: string) =>
  fabricGraph.edges.filter(
    (e) =>
      e.type === "cable" &&
      ((e.source === from && e.target === to) ||
        (e.source === to && e.target === from))
  ).length

describe("collapseClusters", () => {
  it("draws a shut cluster as one card named for it, with its host count", () => {
    const g = collapseClusters(graph, new Set())
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(ids.has(leaf1)).toBe(false)
    expect(ids.has(leaf2)).toBe(false)
    const card = g.nodes.find((n) => n.id === `cl:${CL}`)!
    expect(card.type).toBe("device")
    expect(card.data.name).toBe("prod")
    expect(clusterCardOf(card.data)).toMatchObject({
      id: CL,
      member_count: 2,
      members: ["leaf-01", "leaf-02"],
    })
    // Both hosts are leaves: the card keeps their role.
    expect(card.data.role?.name).toBe(
      fabricGraph.nodes.find((n) => n.id === leaf1)!.data.role?.name
    )
  })

  it("folds the hosts' cables into one counted line per far card", () => {
    const g = collapseClusters(graph, new Set())
    const frame = `cl:${CL}`
    const line = (far: string) =>
      g.edges.find(
        (e) =>
          e.type === "group" &&
          [e.source, e.target].includes(frame) &&
          [e.source, e.target].includes(far)
      )
    const s1 = cables(leaf1, spine1) + cables(leaf2, spine1)
    const s2 = cables(leaf1, spine2) + cables(leaf2, spine2)
    expect(s1).toBeGreaterThan(1)
    expect(
      (line(spine1)?.data as unknown as { cable_count: number }).cable_count
    ).toBe(s1)
    expect(
      (line(spine2)?.data as unknown as { cable_count: number }).cable_count
    ).toBe(s2)
    // No cable is left on a host that is gone, nor between the two.
    for (const e of g.edges) {
      expect([leaf1, leaf2]).not.toContain(e.source)
      expect([leaf1, leaf2]).not.toContain(e.target)
      expect(e.source).not.toBe(e.target)
    }
  })

  it("moves the lines laid over the cables onto the card", () => {
    const g = collapseClusters(graph, new Set())
    const ghost = g.edges.find((e) => e.type === "ghost")!
    expect([ghost.source, ghost.target]).toContain(`cl:${CL}`)
  })

  it("leaves an opened cluster's hosts where they are", () => {
    expect(collapseClusters(graph, new Set([CL]))).toBe(graph)
  })

  it("leaves a cluster with one host on the map alone", () => {
    const one = payload(fabricGraph, { [leaf1]: prod })
    expect(collapseClusters(one, new Set())).toBe(one)
  })

  it("counts a cable between two shut clusters once", () => {
    const g2 = payload(fabricGraph, {
      [leaf1]: prod,
      [leaf2]: prod,
      [spine1]: { id: CL2, name: "spines" },
      [spine2]: { id: CL2, name: "spines" },
    })
    const g = collapseClusters(g2, new Set())
    const between = g.edges.filter(
      (e) =>
        e.type === "group" &&
        new Set([e.source, e.target]).size === 2 &&
        [e.source, e.target].every((x) => x.startsWith("cl:"))
    )
    expect(between).toHaveLength(1)
    const want =
      cables(leaf1, spine1) +
      cables(leaf2, spine1) +
      cables(leaf1, spine2) +
      cables(leaf2, spine2)
    expect(
      (between[0].data as unknown as { cable_count: number }).cable_count
    ).toBe(want)
  })

  it("counts only the cables still on the map", () => {
    const hiddenOne = graph.edges.find(
      (e) =>
        e.type === "cable" &&
        [e.source, e.target].includes(spine1) &&
        [e.source, e.target].includes(leaf1)
    )!
    expect(hiddenOne).toBeTruthy()
    const g = collapseClusters(
      { ...graph, edges: graph.edges.filter((e) => e !== hiddenOne) },
      new Set()
    )
    const line = g.edges.find(
      (e) => e.type === "group" && [e.source, e.target].includes(spine1)
    )!
    expect((line.data as unknown as { cable_count: number }).cable_count).toBe(
      cables(leaf1, spine1) + cables(leaf2, spine1) - 1
    )
  })
})

describe("cluster frames", () => {
  const node = (id: string, name: string, extra: object) => ({
    id,
    type: "device",
    data: { name, ...extra },
  })

  it("stack an open cluster's hosts by name, its name and count on the strip", () => {
    const nodes = [
      node("dev:b", "esx-b", { cluster: prod }),
      node("dev:a", "esx-a", { cluster: prod }),
    ]
    expect(chassisSpecs(nodes, { mode: "off" })).toEqual([])
    const [s] = chassisSpecs(nodes, { mode: "off", clusters: true })
    expect(s).toEqual({
      id: `cl:${CL}`,
      vc: { id: CL, name: "prod · 2 hosts" },
      kind: "cluster",
      orient: "v",
      side: "L",
      members: ["dev:a", "dev:b"],
    })
  })

  it("leave a chassis member to its chassis", () => {
    const vc = { id: VC, name: "stack", position: 1, master: true }
    const nodes = [
      node("dev:a", "esx-a", { cluster: prod, vc }),
      node("dev:b", "esx-b", { cluster: prod, vc: { ...vc, position: 2 } }),
      node("dev:c", "esx-c", { cluster: prod }),
    ]
    const specs = chassisSpecs(nodes, { mode: "v", clusters: true })
    expect(specs.map((s) => s.id)).toEqual([`vc:${VC}`])
    expect(frameOfData(nodes[0].data)).toBe(`vc:${VC}`)
    expect(frameOfData(nodes[2].data)).toBe(`cl:${CL}`)
    expect(frameOfData(nodes[2].data, false)).toBeUndefined()
  })
})

describe("clusters on the Diagram", () => {
  const opts = (o: Partial<DiagramOptions> = {}): DiagramOptions => ({
    mode: "detailed",
    line: "straight",
    colorMode: "cable",
    measure: approxMeasure,
    chassis: { mode: "off", clusters: true },
    ...o,
  })

  it("draws a shut cluster as a card with a host line and counted lines", () => {
    const { nodes, edges } = buildDiagram(
      collapseClusters(graph, new Set()),
      opts()
    )
    const card = nodes.find((n) => n.id === `cl:${CL}`)!
    expect(card.type).toBe("card")
    const lines = edges.filter(
      (e) =>
        e.type === "link" &&
        [e.source, e.target].includes(card.id) &&
        (e.data as DiagramEdgeData).sem !== "ghost"
    )
    const far = new Set(
      lines.map((l) => (l.source === card.id ? l.target : l.source))
    )
    expect(far.has(spine1) && far.has(spine2)).toBe(true)
    // One line per far card, however many cables.
    expect(far.size).toBe(lines.length)
    for (const l of lines) {
      const d = l.data as DiagramEdgeData
      expect(d.sem).toBe("groupedge")
      expect(d.labels.mid?.[0]).toMatch(/^\d+x$/)
    }
  })

  it("draws an open cluster as a frame round its hosts", () => {
    const { nodes } = buildDiagram(
      collapseClusters(graph, new Set([CL])),
      opts()
    )
    const frame = nodes.find((n) => n.id === `cl:${CL}`)!
    expect(frame.type).toBe("chassis")
    const d = frame.data as ChassisNodeData
    expect(d.kind).toBe("cluster")
    expect(d.vc.name).toBe("prod · 2 hosts")
    expect(d.members).toEqual([leaf1, leaf2])
  })

  describe("in the exports", () => {
    const doc = (open: boolean) => {
      const built = buildDiagram(
        collapseClusters(graph, new Set(open ? [CL] : [])),
        opts()
      )
      return toDocument(
        built.model,
        { nodes: built.nodes, edges: built.edges },
        [],
        {
          meta: { title: "Clusters", generated_at: "2026-11-15T12:00:00Z" },
          measure: approxMeasure,
          origin: "https://danbyte.example",
        }
      )
    }

    it("draws an open cluster's frame as a chassis does, linked to the cluster", () => {
      const d = doc(true)
      const band = d.bands.find((b) => b.kind === "chassis")!
      expect(band).toMatchObject({
        id: `cl:${CL}`,
        label: "prod · 2 hosts",
        link: `https://danbyte.example/clusters/${CL}`,
      })
      const svg = toSvg(d, { measure: approxMeasure, links: true })
      expect(svg).toContain(`href="https://danbyte.example/clusters/${CL}"`)
      const xml = toDrawio([d], { measure: approxMeasure })
      expect(xml).toMatch(
        new RegExp(
          `<object label="prod · 2 hosts" link="https://danbyte.example/clusters/${CL}"[^>]*><mxCell style="[^"]*swimlane`
        )
      )
    })

    it("draws a shut cluster as a card with its host line", () => {
      const d = doc(false)
      const card = d.nodes.find((n) => n.id === `cl:${CL}`)!
      expect(card).toBeTruthy()
      const svg = toSvg(d, { measure: approxMeasure })
      expect(svg).toContain(">prod<")
      expect(svg).toContain(">2 hosts<")
    })
  })
})
