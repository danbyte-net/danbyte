// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import type * as ReactFlow from "@xyflow/react"
import type { Edge, Node } from "@xyflow/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { leaves, routeThrough } from "./link-geometry"
import type { DiagramEdgeData } from "./types"

// The link as drawn on the canvas: each end's port name, then its
// address, ON the cable - every label over a box that breaks the line -
// and the link's subnet as a chip on the middle of the line.

const nodes = new Map<string, Node>()

vi.mock("@xyflow/react", async (importOriginal) => {
  const m = await importOriginal<typeof ReactFlow>()
  return {
    ...m,
    // The edge reads its cards' boxes from the store: these, as laid out.
    useInternalNode: (id: string) => {
      const n = nodes.get(id)
      if (!n) return undefined
      return {
        ...n,
        measured: { width: n.width, height: n.height },
        internals: {
          positionAbsolute: {
            x: n.position.x - n.width! / 2,
            y: n.position.y - n.height! / 2,
          },
        },
      }
    },
    // The chip is portalled out of the edge on the canvas.
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => (
      <foreignObject>{children}</foreignObject>
    ),
  }
})

const { LinkEdge } = await import("./link-edge")

afterEach(cleanup)

const A = "dev:10000000-0000-4000-8000-000000000001"
const B = "dev:20000000-0000-4000-8000-000000000002"

const graph: TopologyGraph = {
  nodes: [A, B].map((id, i) => ({
    id,
    type: "device" as const,
    data: { name: `sw${i}`, device_id: id.slice(4) },
  })),
  edges: [
    {
      id: "e:c1",
      source: A,
      target: B,
      type: "cable",
      data: {
        cable_id: "c1",
        pairs: [
          {
            a: "sw0:Gi1/0/3",
            b: "sw1:Gi1/0/4",
            a_port: "Gi1/0/3",
            b_port: "Gi1/0/4",
            subnets: [
              { cidr: "10.0.0.0/31", family: 4, a: "10.0.0.0", b: "10.0.0.1" },
            ],
          },
        ],
      },
    },
  ],
}

function draw(o: Partial<DiagramOptions> = {}, move = 0) {
  const b = buildDiagram(graph, {
    mode: "detailed",
    line: "straight",
    colorMode: "cable",
    measure: approxMeasure,
    positions: { [A]: [0, 0], [B]: [400, 0] },
    ...o,
  })
  nodes.clear()
  for (const n of b.nodes)
    nodes.set(
      n.id,
      n.id === B
        ? { ...n, position: { x: n.position.x, y: n.position.y + move } }
        : n
    )
  const e = b.edges.find((x) => x.type === "link") as Edge<DiagramEdgeData>
  // Where the drop plans it: the model relinked with the card moved.
  const dropped = () =>
    relinkDiagram(b.model, [...nodes.values()]).edges.find(
      (x) => x.id === e.id
    )!.data as DiagramEdgeData
  const { container } = render(
    <svg>
      <LinkEdge
        {...({
          id: e.id,
          source: e.source,
          target: e.target,
          data: e.data,
          style: e.style,
        } as Parameters<typeof LinkEdge>[0])}
      />
    </svg>
  )
  return { container, data: e.data!, dropped }
}

/** Each end label: its text, and whether it sits on a gap box. */
const labels = (c: HTMLElement) =>
  [...c.querySelectorAll(".topo-endlabel g")].map((g) => ({
    text: g.querySelector("text")?.textContent,
    gap: !!g.querySelector("rect"),
    x: Number(g.querySelector("text")?.getAttribute("x")),
    y: Number(g.querySelector("text")?.getAttribute("y")),
  }))

describe("LinkEdge", () => {
  it("draws the port names, then the addresses, on the line", () => {
    const { container, data } = draw()
    const got = labels(container)
    expect(got.map((l) => l.text)).toEqual([
      "Gi1/0/3",
      "10.0.0.0",
      "Gi1/0/4",
      "10.0.0.1",
    ])
    // Every one breaks the line for itself.
    expect(got.every((l) => l.gap)).toBe(true)
    // Along the horizontal line from each end: port name nearer its card.
    const y = data.plan![0].pts[0].y
    for (const l of got) expect(Math.abs(l.y - y)).toBeLessThan(6)
    expect(got[0].x).toBeLessThan(got[1].x)
    expect(got[2].x).toBeGreaterThan(got[3].x)
    // The subnet is the chip on the middle of the line.
    expect(container.querySelector(".topo-midlabel")?.textContent).toBe(
      "10.0.0.0/31"
    )
  })

  it("leaves the names off with Ports off, and the addresses with IPs off", () => {
    const noPorts = draw({ labels: ["subnet", "ip"] })
    expect(labels(noPorts.container).map((l) => l.text)).toEqual([
      "10.0.0.0",
      "10.0.0.1",
    ])
    cleanup()
    const noIps = draw({ labels: ["port"] })
    expect(labels(noIps.container).map((l) => l.text)).toEqual([
      "Gi1/0/3",
      "Gi1/0/4",
    ])
    expect(noIps.container.querySelector(".topo-midlabel")).toBeNull()
  })

  it("keeps them on the line while a card is dragged, until the drop plans it", () => {
    // The far card moved since the plan: drawn unplanned.
    const { container } = draw({}, 120)
    const got = labels(container)
    expect(got.map((l) => l.text)).toEqual([
      "Gi1/0/3",
      "10.0.0.0",
      "Gi1/0/4",
      "10.0.0.1",
    ])
    const turned = [...container.querySelectorAll(".topo-endlabel g")].map(
      (g) => g.getAttribute("transform")
    )
    // A slanted line: every label turned along it.
    expect(turned.every((t) => t?.startsWith("rotate("))).toBe(true)
  })

  it("draws a Bendy line while a card is dragged as the drop settles it", () => {
    const { container, dropped } = draw({ line: "bendy" }, 120)
    const path = container.querySelector(".react-flow__edge-path")
    const plan = dropped().plan![0]
    expect(path?.getAttribute("d")).toBe(
      routeThrough("bendy", plan.pts, leaves(plan.pts)).d
    )
  })
})
