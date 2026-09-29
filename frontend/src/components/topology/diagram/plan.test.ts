import { describe, expect, it } from "vitest"
import type { Edge } from "@xyflow/react"

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
import { endTextWidth } from "@/lib/diagram/geometry"
import { leadStart, linkEnds } from "./anchors"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { LANE, obstacles, pathClear } from "./lanes"
import {
  bendyLine,
  curvedPolyline,
  leaves,
  linkRoute,
  routeThrough,
} from "./link-geometry"
import { nubRun, planEdges } from "./plan"
import { segHitsRect } from "./spatial"
import type {
  Anchor,
  DiagramEdgeData,
  DiagramMode,
  LineType,
  Pt,
  Rect,
} from "./types"

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

// The owner's firewall to server, Bendy in Detailed: the firewall's nub on
// its bottom edge, the server a photo lower down and 1000 px to the right,
// its port on its top edge. While the server was dragged the cable was a
// sweeping S; dropped, it went straight down past its label, turned hard
// and ran flat along the middle of the gap (the control points were held
// to half the gap, and a card near the control polygon pulled them in
// further). Settled, it is the curve drawn while dragging.
describe("Bendy lines", () => {
  const fw: Rect = { x: 0, y: 0, w: 200, h: 60 }
  const srv: Rect = { x: 980, y: 320, w: 240, h: 100 }
  const nub: Anchor = { k: "side", side: "B", off: 40, port: "ethernet1/1" }
  const port: Anchor = {
    k: "point",
    fx: 0.25,
    fy: 0.2,
    exit: "T",
    port: "Ethernet 1",
  }
  const data = {
    sem: "cable",
    pairKey: "fw|srv",
    line: "bendy",
    a: [nub],
    b: [port],
    labels: {},
  } as unknown as DiagramEdgeData
  const edge: Edge<DiagramEdgeData> = {
    id: "fw-srv",
    source: "fw",
    target: "srv",
    type: "link",
    data,
  }
  const [[a, b]] = linkEnds(data, fw, srv, false)
  const lead = leadStart(srv, port)!
  const w = (text: string) => endTextWidth(text, approxMeasure)
  const runs = [
    nubRun(true, false, [w("ethernet1/1")]),
    nubRun(true, true, [w("Ethernet 1")]),
  ] as const
  /** The line drawn while the server is dragged: the unplanned route
   * through the ends as they stand, then the photo port's lead. */
  const dragged = [...linkRoute("bendy", a, b, { runs }).pts, lead]
  const plan = (others: [string, Rect][] = [], to = srv) =>
    planEdges({
      edges: [edge],
      rects: new Map<string, Rect>([["fw", fw], ["srv", to], ...others]),
      solid: () => true,
      mode: "detailed",
      measure: approxMeasure,
    }).plans.get(edge.id)!.cables[0]
  const route = (pts: Pt[]) => routeThrough("bendy", pts, leaves(pts))
  /** The sharpest the drawn line turns over 8 px, degrees. */
  const sharpest = (pts: Pt[]) => {
    const r = route(pts)
    let most = 0
    for (let d = 0; d + 8 <= r.length; d++) {
      const p = r.at(d / r.length).angle
      const q = r.at((d + 8) / r.length).angle
      most = Math.max(most, Math.abs(((q - p + 540) % 360) - 180))
    }
    return most
  }
  /** The longest stretch, px, that runs level (within 1 degree). */
  const level = (pts: Pt[]) => {
    const r = route(pts)
    let most = 0
    let run = 0
    for (let d = 0; d <= r.length; d++) {
      const h = ((r.at(d / r.length).angle % 180) + 180) % 180
      run = Math.min(h, 180 - h) <= 1 ? run + 1 : 0
      most = Math.max(most, run)
    }
    return most
  }
  const through = (pts: Pt[], box: Rect) => {
    const line = curvedPolyline(pts)
    return line.some((p, i) => i > 0 && segHitsRect(line[i - 1], p, box))
  }
  // What it used to settle on: control points held to half the gap.
  const gap = b.y - a.y
  const held = [...bendyLine(a, b, runs[0], runs[1], [gap / 2, gap / 2]), lead]
  // Cards near the curve: in its control polygon's reach, clear of it.
  const lenovo: [string, Rect] = ["lenovo", { x: 48, y: 214, w: 72, h: 46 }]
  const palo: [string, Rect] = ["palo", { x: 960, y: 120, w: 72, h: 50 }]

  it("settles on the curve drawn while dragging, cards close by", () => {
    const got = plan([lenovo, palo])
    expect(got.line).toBeUndefined()
    expect(got.pts).toEqual(dragged)
    // Both port names on their straight runs.
    expect(got.a).toBeTruthy()
    expect(got.b).toBeTruthy()
    // The cards touch the control polygon - which used to pull the curve
    // in - but not the curve.
    const obs = obstacles([lenovo, palo])
    expect(pathClear(obs, bendyLine(a, b), ["fw", "srv"])).toBe(false)
    expect(through(got.pts, lenovo[1]) || through(got.pts, palo[1])).toBe(false)
  })

  it("sweeps from its labels instead of turning hard and running flat", () => {
    const got = plan([lenovo, palo]).pts
    // Down past the middle of the gap, across, and up above it before it
    // comes down into the port: an S, not a level run halfway.
    const r = route(got)
    const half = a.y + gap / 2
    const at = Array.from({ length: 101 }, (_, i) => r.at(i / 100))
    const mid = (a.x + b.x) / 2
    expect(
      Math.max(...at.filter((p) => p.x < mid).map((p) => p.y))
    ).toBeGreaterThan(half + 5)
    expect(
      Math.min(...at.filter((p) => p.x > mid).map((p) => p.y))
    ).toBeLessThan(half - 5)
    expect(level(got)).toBeLessThan(100)
    expect(level(held)).toBeGreaterThan(200)
    expect(sharpest(held)).toBeGreaterThan(sharpest(got) + 5)
  })

  it("bends round a card in its way, still a curve", () => {
    const block: [string, Rect] = ["block", { x: 480, y: 150, w: 120, h: 60 }]
    expect(through(dragged, block[1])).toBe(true)
    const got = plan([block])
    expect(got.line).toBeUndefined()
    expect(got.pts).not.toEqual(dragged)
    expect(through(got.pts, block[1])).toBe(false)
    expect(level(got.pts)).toBeLessThan(100)
    expect(sharpest(got.pts)).toBeLessThan(sharpest(held) - 5)
  })

  it("keeps facing ends in line short of the middle of the gap", () => {
    // The server straight under the firewall: no overshoot, no wave -
    // the line only ever goes down.
    const r = route(plan([], { ...srv, x: -30 }).pts)
    let y = -Infinity
    for (let i = 0; i <= 200; i++) {
      const at = r.at(i / 200)
      expect(at.y).toBeGreaterThanOrEqual(y - 0.01)
      y = at.y
    }
  })
})
