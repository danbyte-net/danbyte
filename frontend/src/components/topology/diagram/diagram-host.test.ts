import { describe, expect, it } from "vitest"

import { approxMeasure } from "@/lib/diagram/measure"
import { aarhusGraph } from "../__fixtures__/aarhus-graph"
import { fabricGraph } from "../__fixtures__/fabric-graph"
import { fanoutGraph } from "../__fixtures__/fanout-graph"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import { diagramHost } from "./diagram-host"
import type { HostReply, WireOptions } from "./diagram-host"

// The worker's handler, run in place: it builds and relinks exactly as the
// page would, and everything it answers crosses a message boundary.

const host = () =>
  diagramHost(() =>
    Promise.resolve({ measure: approxMeasure, kind: "approx" as const })
  )
const OPTS: WireOptions = {
  mode: "detailed",
  line: "elbow",
  colorMode: "cable",
}

describe("diagramHost", () => {
  it("builds what buildDiagram builds, and it survives a structured clone", async () => {
    for (const graph of [aarhusGraph, fanoutGraph, fabricGraph]) {
      const reply = await host()({ kind: "build", id: 1, graph, opts: OPTS })
      if (reply.kind !== "built") throw new Error(JSON.stringify(reply))
      const direct = buildDiagram(graph, { ...OPTS, measure: approxMeasure })
      expect(reply.nodes).toEqual(direct.nodes)
      expect(reply.edges).toEqual(direct.edges)
      expect(reply.measure).toBe("approx")
      expect("measure" in reply.wire).toBe(false)
      expect(structuredClone(reply)).toEqual(reply)
    }
  })

  it("keeps the graph it was sent, and relinks the model it built", async () => {
    const handle = host()
    await handle({ kind: "build", id: 1, graph: aarhusGraph, opts: OPTS })
    const second = await handle({
      kind: "build",
      id: 2,
      opts: { ...OPTS, line: "straight" },
    })
    if (second.kind !== "built") throw new Error("no build")
    expect(second.id).toBe(2)
    expect(second.nodes).toHaveLength(
      buildDiagram(aarhusGraph, { ...OPTS, measure: approxMeasure }).nodes
        .length
    )
    const moved = second.nodes.map((n, i) =>
      i === 2
        ? { ...n, position: { x: n.position.x + 80, y: n.position.y } }
        : n
    )
    const reply: HostReply = await handle({
      kind: "relink",
      id: 3,
      model: second.model,
      at: moved.map((n) => [n.id, n.position.x, n.position.y]),
    })
    if (reply.kind !== "relinked") throw new Error(JSON.stringify(reply))
    const direct = relinkDiagram(
      buildDiagram(aarhusGraph, {
        ...OPTS,
        line: "straight",
        measure: approxMeasure,
      }).model,
      moved
    )
    expect(reply.edges).toEqual(direct.edges)
    expect(new Map(reply.cards)).toEqual(direct.cards)
    expect(new Map(reply.junctions)).toEqual(direct.junctions)
    expect(structuredClone(reply)).toEqual(reply)
  })

  it("answers an error for a model it no longer has", async () => {
    const reply = await host()({ kind: "relink", id: 9, model: 42, at: [] })
    expect(reply).toMatchObject({ kind: "error", id: 9 })
  })
})
