import { describe, expect, it } from "vitest"

import type { TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import {
  aarhusGraph,
  aarhusId,
  aarhusLevels,
  aarhusPositions,
} from "../__fixtures__/aarhus-graph"
import { fabricGraph } from "../__fixtures__/fabric-graph"
import {
  boxOf,
  crowdedRuns,
  drawn,
  earlyCrossings,
  labelFaults,
  throughCards,
} from "../__fixtures__/route-checks"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { LANE } from "./lanes"
import type { DiagramEdgeData, DiagramMode, LineType, Rect } from "./types"

// The planned lines on real maps: the owner's Århus DC view (the saved
// arrangement and the auto layout, with and without Levels) and the parity
// fabric. Every elbow keeps a lane of its own, no line runs behind a card
// it does not connect, the cables leaving one side of a card do not cross
// on their way out, and every port name sits on its own cable's first
// straight run, clear of the other names and cables.

const build = (graph: TopologyGraph, o: Partial<DiagramOptions>) =>
  buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })

const cardsOf = (nodes: ReturnType<typeof build>["nodes"]) =>
  new Map<string, Rect>(
    nodes.filter((n) => n.type === "card").map((n) => [n.id, boxOf(n)])
  )

const fabric: TopologyGraph = {
  ...fabricGraph,
  nodes: fabricGraph.nodes.map(
    (n): TopoNode => ({ ...n, data: { ...n.data, card: undefined } })
  ),
}

/** Maps, and the least gap between two cables' parallel runs on each. On
 * the owner's map every cable keeps a full lane. The parity fabric packs
 * nine cables between two spines and four leaves into one tier gap, with
 * ports level across it: lanes may close up there, but two cables are
 * never drawn on one line. */
const MAPS: [string, TopologyGraph, Partial<DiagramOptions>, number][] = [
  ["århus, saved", aarhusGraph, { positions: aarhusPositions }, LANE - 0.5],
  [
    "århus, saved with Levels",
    aarhusGraph,
    { positions: aarhusPositions, ...aarhusLevels },
    LANE - 0.5,
  ],
  ["århus, auto", aarhusGraph, {}, LANE - 0.5],
  ["århus, Levels", aarhusGraph, aarhusLevels, LANE - 0.5],
  ["fabric", fabric, { direction: "TB" }, 3.5],
  [
    "fabric, Levels",
    fabric,
    { direction: "TB", roleOrder: ["Spine", "Leaf", "Server"] },
    3.5,
  ],
]
const MODES: DiagramMode[] = ["detailed", "simple"]

describe("planned elbows", () => {
  for (const [name, graph, o, gap] of MAPS)
    for (const mode of MODES)
      it(`${name} · ${mode}: own lanes, clear of cards`, () => {
        const b = build(graph, { ...o, mode })
        const cables = drawn(b.nodes, b.edges, approxMeasure)
        expect(cables.length).toBeGreaterThan(0)
        expect(crowdedRuns(cables, gap)).toEqual([])
        expect(throughCards(cables, cardsOf(b.nodes))).toEqual([])
      })

  it("nests the firewall's cables out of its bottom side (the owner's case)", () => {
    const b = build(aarhusGraph, { positions: aarhusPositions })
    const fw = aarhusId("aarhus-fw1")
    const out = drawn(b.nodes, b.edges, approxMeasure).filter(
      (c) =>
        (c.source === fw && c.pts[1].y > c.pts[0].y) ||
        (c.target === fw && c.pts.at(-2)!.y > c.pts.at(-1)!.y)
    )
    const from = (c: (typeof out)[number]) =>
      c.source === fw ? c.pts : [...c.pts].reverse()
    // ethernet1/6, ethernet1/7 (to core2) and ethernet1/1 (to core1).
    expect(out).toHaveLength(3)
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(earlyCrossings(from(out[i]), from(out[j]))).toBe(0)
    // Each runs straight down past its own port name before it turns.
    for (const c of out) {
      const pts = from(c)
      const label = c.labels.find((l) => (l.end === "a") === (c.source === fw))!
      expect(label).toBeDefined()
      expect(pts[1].y - pts[0].y).toBeGreaterThanOrEqual(
        label.along + label.box.hw + 4
      )
    }
  })

  it("separates Simple lines right after the point they share", () => {
    const b = build(aarhusGraph, {
      positions: aarhusPositions,
      mode: "simple",
    })
    const core1 = aarhusId("aarhus-core1")
    const into = drawn(b.nodes, b.edges, approxMeasure)
      .filter((c) => c.target === core1 || c.source === core1)
      .map((c) => (c.target === core1 ? c.pts : [...c.pts].reverse()))
      // Arriving from above, at the top side's midpoint.
      .filter((pts) => pts.at(-2)!.y < pts.at(-1)!.y)
    expect(into.length).toBeGreaterThanOrEqual(2)
    // Each turns off right after the point, lines turning the same way
    // each at a depth of their own.
    const turns = into.map((pts) => ({
      depth: pts.at(-1)!.y - pts.at(-2)!.y,
      way: Math.sign(pts.at(-3)!.x - pts.at(-2)!.x),
    }))
    for (const t of turns) expect(t.depth).toBeLessThanOrEqual(8 + LANE * 4)
    for (const way of [-1, 1]) {
      const same = turns.filter((t) => t.way === way).map((t) => t.depth)
      expect(new Set(same.map(Math.round)).size).toBe(same.length)
    }
    expect(new Set(turns.map((t) => t.way)).size).toBeGreaterThan(1)
  })
})

describe("port names", () => {
  for (const [name, graph, o] of MAPS)
    for (const line of ["elbow", "straight", "bendy"] as LineType[])
      it(`${name} · ${line}: along their cable, clear of the rest`, () => {
        const b = build(graph, { ...o, line })
        const cables = drawn(b.nodes, b.edges, approxMeasure)
        expect(labelFaults(cables)).toEqual([])
      })

  it("show on most cables of the saved Århus view", () => {
    const b = build(aarhusGraph, { positions: aarhusPositions })
    let shown = 0
    let all = 0
    for (const e of b.edges) {
      const d = e.data as DiagramEdgeData
      for (const p of d.plan ?? [])
        for (const end of ["a", "b"] as const)
          if (p[end] !== undefined) {
            all++
            if (p[end]) shown++
          }
    }
    expect(all).toBeGreaterThan(20)
    expect(shown / all).toBeGreaterThan(0.9)
  })
})

describe("middle chips", () => {
  it("move off cards and other labels, or wait for a hover", () => {
    const b = build(aarhusGraph, {
      positions: aarhusPositions,
      mode: "simple",
    })
    const chips = b.edges.filter(
      (e) => (e.data as DiagramEdgeData).labels.mid?.length
    )
    expect(chips.length).toBeGreaterThan(0)
    for (const e of chips) {
      const d = e.data as DiagramEdgeData
      expect(d.midT).toBeGreaterThanOrEqual(0.18)
      expect(d.midT).toBeLessThanOrEqual(0.82)
    }
  })
})
