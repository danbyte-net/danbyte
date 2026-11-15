import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { dependencyEdgeParts } from "./dependency-edge"
import { classifyEdges, orientHubToLeaf } from "./edge-semantics"
import { DEPENDENCY_DASH, dependencyStroke } from "./edge-style"
import { DEPENDENCIES, edgeHidden, linkFamily, NO_TOPO_HIDDEN } from "./hidden"
import { legendRows } from "./legend"
import { dependencyLabel } from "./overlay-edge"
import { impactHighlight } from "./what-if"

// The Topology map's Dependencies layer and its what-if (#450).

const node = (id: string, device_id = id) =>
  ({ id, type: "device", data: { name: id, device_id } }) as TopoNode

const dep = (
  id: string,
  up: string,
  down: string,
  data: NonNullable<TopoEdge["data"]> = {}
): TopoEdge => ({
  id,
  source: up,
  target: down,
  type: "dependency",
  data: { kind: "dependency", upstream: up, downstream: down, ...data },
})

const fibre = {
  id: "m1",
  name: "Fibre",
  slug: "fibre",
  color: "#f97316",
  text_color: "#000000",
  icon: "",
  line_style: "dashed" as const,
}

describe("dependency edges", () => {
  const graph: TopologyGraph = {
    nodes: ["core", "dist", "acc"].map((n) => node(n)),
    edges: [
      dep("dep:1", "core", "dist", { medium: fibre, redundancy_group: "up" }),
      dep("dep:2", "dist", "acc"),
      {
        id: "c1",
        source: "acc",
        target: "dist",
        type: "cable",
        data: { pairs: [{ a: "x", b: "y" }] },
      },
    ],
  }

  it("classify as their own kind, upstream to downstream", () => {
    const out = classifyEdges(graph, { fold: "pair" })
    const deps = out.filter((c) => c.sem === "dependency")
    expect(deps.map((c) => [c.source, c.target])).toEqual([
      ["core", "dist"],
      ["dist", "acc"],
    ])
    // Never folded into the pair's cables.
    expect(out.filter((c) => c.sem === "cable")).toHaveLength(1)
  })

  it("are never turned hub to leaf", () => {
    const edges = classifyEdges(graph, { fold: "none" }).map((c) => ({
      id: c.id,
      source: c.source,
      target: c.target,
      data: { sem: c.sem },
    }))
    const { flipped } = orientHubToLeaf(edges)
    expect([...flipped].filter((id) => id.startsWith("dep:"))).toEqual([])
  })

  it("draw in the medium's colour and dash with an arrow downstream", () => {
    const parts = dependencyEdgeParts(graph.edges[0].data)
    expect(parts.type).toBe("overlay")
    expect(parts.style.stroke).toBe("#f97316")
    expect(parts.style.strokeDasharray).toBe(DEPENDENCY_DASH.dashed)
    expect(parts.markerEnd).toMatchObject({ type: "arrowclosed" })
    expect(parts.label).toBe("up")
    const peer = dependencyEdgeParts({ kind: "peer" })
    expect(peer).not.toHaveProperty("markerEnd")
    expect(peer.style.stroke).toBe("var(--muted-foreground)")
    expect(dependencyStroke(null)).toEqual({
      stroke: "var(--muted-foreground)",
    })
  })

  it("name both ends on hover", () => {
    expect(dependencyLabel(graph.edges[0].data!)).toBe(
      "dist depends on core · Fibre · group up"
    )
    expect(
      dependencyLabel({ kind: "peer", upstream: "a", downstream: "b" })
    ).toBe("a ↔ b · peer")
  })

  it("hide as one link family", () => {
    expect(linkFamily(graph.edges[0])).toBe(DEPENDENCIES)
    expect(
      edgeHidden(graph.edges[0], { ...NO_TOPO_HIDDEN, kinds: [DEPENDENCIES] })
    ).toBe(true)
  })

  it("get a legend row only while drawn", () => {
    const rows = (dependencies: boolean) =>
      legendRows({
        viewStyle: "diagram",
        grouped: false,
        colorMode: "none",
        dependencies,
      }).map((r) => r.label)
    expect(rows(true)).toContain("Dependency →")
    expect(rows(false)).not.toContain("Dependency →")
  })
})

describe("impactHighlight", () => {
  it("marks the failed card and the impacted ones, and counts the rest", () => {
    const h = impactHighlight(
      { nodes: [node("n-core", "core"), node("n-dist", "dist")] },
      "core",
      {
        devices: [
          {
            id: "dist",
            name: "dist",
            level: "outage",
            depth: 1,
            via: [],
            site: null,
            rack: null,
          },
          {
            id: "far",
            name: "far",
            level: "reduced_redundancy",
            depth: 2,
            via: [],
            site: null,
            rack: null,
          },
        ],
      }
    )
    expect([...h.marks]).toEqual([
      ["n-core", "root"],
      ["n-dist", "outage"],
    ])
    expect(h.offMap).toBe(1)
  })
})
