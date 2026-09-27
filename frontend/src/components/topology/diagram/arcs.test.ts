import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { crosses, drawn, throughCards } from "../__fixtures__/route-checks"
import { ARC, arcControls, arcFor, solveArc, solveArcs } from "./arcs"
import type { ArcAsk } from "./arcs"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { obstacles } from "./lanes"
import type { Anchor, DiagramEdgeData, Pt, Rect } from "./types"

// Cyclical arcs: the apex line rises until the curve - drawn by draw.io's
// curved rule - clears every card between its ends, nested arcs keep apart,
// and the view's default arcs only the links that would cross a card.

/** mxGraph's paintCurvedLine through `pts`, re-implemented here: `M S,
 * Q P1 mid(P1,P2), …, Q Pn T`, sampled `n` times per piece. */
function curve(pts: Pt[], n = 32): Pt[] {
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const out: Pt[] = [pts[0]]
  let from = pts[0]
  for (let i = 1; i < pts.length - 1; i++) {
    const to = i < pts.length - 2 ? mid(pts[i], pts[i + 1]) : pts.at(-1)!
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const u = 1 - t
      out.push({
        x: u * u * from.x + 2 * u * t * pts[i].x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * pts[i].y + t * t * to.y,
      })
    }
    from = to
  }
  return out
}

const inside = (p: Pt, r: Rect, pad: number) =>
  p.x > r.x - pad &&
  p.x < r.x + r.w + pad &&
  p.y > r.y - pad &&
  p.y < r.y + r.h + pad

/** A row of cards 120 x 40, centres 200 apart at y = 0. */
function row(n: number, extra: [string, Rect][] = []): Map<string, Rect> {
  const m = new Map<string, Rect>()
  for (let i = 0; i < n; i++)
    m.set(`c${i}`, { x: i * 200 - 60, y: -20, w: 120, h: 40 })
  for (const [id, r] of extra) m.set(id, r)
  return m
}

const top = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y })

function ask(cards: Map<string, Rect>, a: string, b: string, s: 1 | -1 = -1) {
  const ra = cards.get(a)!
  const rb = cards.get(b)!
  const pa = s < 0 ? top(ra) : { x: ra.x + ra.w / 2, y: ra.y + ra.h }
  const pb = s < 0 ? top(rb) : { x: rb.x + rb.w / 2, y: rb.y + rb.h }
  return { key: `${a}-${b}`, a: pa, b: pb, axis: "x", s, own: [a, b] } as ArcAsk
}

describe("arcControls", () => {
  it("puts both control points on the apex line, the curve touching it mid-span", () => {
    const [p1, p2] = arcControls({ x: 0, y: 0 }, { x: 400, y: 0 }, "x", -80)
    expect(p1).toEqual({ x: 60, y: -80 })
    expect(p2).toEqual({ x: 340, y: -80 })
    const pts = curve([{ x: 0, y: 0 }, p1, p2, { x: 400, y: 0 }])
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-80, 6)
  })
})

describe("solveArc", () => {
  it("clears every card between its ends by 16 px at 64 samples and more", () => {
    // A taller card in the middle of the row.
    const cards = row(5, [["tall", { x: 330, y: -90, w: 140, h: 110 }]])
    cards.delete("c2")
    const res = solveArc(ask(cards, "c0", "c4"), obstacles(cards))
    expect(res.clear).toBe(true)
    const pts = curve(res.pts, 128)
    for (const [id, r] of cards) {
      if (id === "c0" || id === "c4") continue
      for (const p of pts.slice(1, -1))
        expect(inside(p, r, ARC.CLEAR - 0.5), `${id} at ${p.x},${p.y}`).toBe(
          false
        )
    }
    // Over the tall card, not just the row.
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(-90 - ARC.CLEAR)
    expect(res.pts).toHaveLength(4)
  })

  it("keeps a least height over an empty span", () => {
    const cards = row(2)
    const res = solveArc(ask(cards, "c0", "c1"), obstacles(cards))
    expect(res.h).toBeCloseTo(ARC.MIN + ARC.RISE * 200, 6)
  })

  it("bulges the other way when flipped", () => {
    const cards = row(4)
    const res = solveArc(ask(cards, "c0", "c3", 1), obstacles(cards))
    const pts = curve(res.pts)
    for (const p of pts.slice(1, -1)) expect(p.y).toBeGreaterThan(20)
    for (const id of ["c1", "c2"])
      for (const p of pts)
        expect(inside(p, cards.get(id)!, ARC.CLEAR - 0.5)).toBe(false)
  })

  it("runs along y for stacked cards, bulging left", () => {
    const cards = new Map<string, Rect>(
      [0, 1, 2].map((i) => [
        `v${i}`,
        { x: -60, y: i * 120 - 20, w: 120, h: 40 },
      ])
    )
    const res = solveArc(
      {
        key: "v",
        a: { x: -60, y: 0 },
        b: { x: -60, y: 240 },
        axis: "y",
        s: -1,
        own: ["v0", "v2"],
      },
      obstacles(cards)
    )
    const pts = curve(res.pts)
    for (const p of pts)
      expect(inside(p, cards.get("v1")!, ARC.CLEAR - 0.5)).toBe(false)
    expect(Math.min(...pts.map((p) => p.x))).toBeLessThan(-60 - ARC.CLEAR)
  })

  it("says so when even the highest arc allowed is not clear", () => {
    const cards = row(3, [["wall", { x: 150, y: -5000, w: 100, h: 5020 }]])
    const res = solveArc(ask(cards, "c0", "c2"), obstacles(cards))
    expect(res.clear).toBe(false)
    expect(res.h).toBeCloseTo(ARC.CAP_SPAN * 400 + ARC.CAP, 6)
  })
})

describe("solveArcs", () => {
  it("nests a longer arc outside a shorter one, 12 px apart", () => {
    const cards = row(6)
    const out = solveArcs(
      [ask(cards, "c0", "c5"), ask(cards, "c1", "c4")],
      obstacles(cards)
    )
    const outer = out.get("c0-c5")!
    const inner = out.get("c1-c4")!
    expect(outer.h).toBeGreaterThanOrEqual(inner.h + ARC.NEST - 0.5)
    // Across the inner arc's middle, the outer one stays 12 px above it.
    const o = curve(outer.pts, 256)
    const yAt = (pts: Pt[], x: number) =>
      pts.reduce((b, p) => (Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b)).y
    for (const p of curve(inner.pts, 64).slice(20, 110))
      expect(p.y - yAt(o, p.x)).toBeGreaterThanOrEqual(ARC.NEST - 1)
  })

  it("solves the same arcs the same way whatever order they come in", () => {
    const cards = row(6)
    const asks = [
      ask(cards, "c0", "c5"),
      ask(cards, "c1", "c4"),
      ask(cards, "c0", "c3"),
    ]
    const a = solveArcs(asks, obstacles(cards))
    const b = solveArcs([...asks].reverse(), obstacles(cards))
    for (const k of a.keys()) expect(b.get(k)).toEqual(a.get(k))
  })
})

describe("arcFor", () => {
  const cards = row(4)
  const obs = obstacles(cards)
  const r = (id: string) => cards.get(id)!

  it("arcs the view's default only between level cards with one between", () => {
    expect(
      arcFor(r("c0"), r("c1"), { always: false, obs, own: ["c0", "c1"] })
    ).toBeNull()
    expect(
      arcFor(r("c0"), r("c2"), { always: false, obs, own: ["c0", "c2"] })
    ).toEqual({
      axis: "x",
      s: -1,
    })
    // Not level: a card a row down.
    const low = { x: 340, y: 200, w: 120, h: 40 }
    expect(
      arcFor(r("c0"), low, { always: false, obs, own: ["c0", "low"] })
    ).toBeNull()
  })

  it("always arcs a link's own cyclical line, to its saved side", () => {
    expect(
      arcFor(r("c0"), r("c1"), { always: true, obs, own: ["c0", "c1"] })
    ).toEqual({
      axis: "x",
      s: -1,
    })
    expect(
      arcFor(r("c0"), r("c2"), {
        always: false,
        flip: 1,
        obs,
        own: ["c0", "c2"],
      })
    ).toEqual({ axis: "x", s: 1 })
  })

  it("takes the side with the lower arc", () => {
    // A tall card above the middle of the row: below is lower.
    const more = row(3, [["up", { x: 150, y: -300, w: 100, h: 290 }]])
    expect(
      arcFor(more.get("c0")!, more.get("c2")!, {
        always: false,
        obs: obstacles(more),
        own: ["c0", "c2"],
      })
    ).toEqual({ axis: "x", s: 1 })
  })
})

// ── On the Diagram ──────────────────────────────────────────────────────

/** Six leaves in a row under a spine: links over cards, beside ones, and
 * up to the spine. */
function rowGraph(): {
  graph: TopologyGraph
  positions: Record<string, [number, number]>
} {
  const nodes: TopoNode[] = []
  const positions: Record<string, [number, number]> = {}
  const node = (name: string, color: string, at: [number, number]) => {
    nodes.push({
      id: `dev:${name}`,
      type: "device",
      data: { name, device_id: name, role: { name: color, color } },
    })
    positions[`dev:${name}`] = at
  }
  for (let i = 0; i < 6; i++) node(`r${i}`, "#0ea5e9", [i * 200, 0])
  node("up", "#6366f1", [500, -260])
  const edges: TopoEdge[] = (
    [
      ["r0", "r1"],
      ["r0", "r3"],
      ["r0", "r5"],
      ["r1", "r4"],
      ["r2", "r3"],
      ["r2", "r4"],
      ["up", "r2"],
      ["up", "r3"],
    ] as const
  ).map(([s, t], k) => ({
    id: `e:c${k}:${s}:${t}`,
    source: `dev:${s}`,
    target: `dev:${t}`,
    type: "cable",
    data: {
      cable_id: `c${k}`,
      pairs: [
        {
          a: `${s}:e${k}`,
          b: `${t}:e${k}`,
          a_port: `Ethernet1/${k}`,
          b_port: `Ethernet1/${k}`,
        },
      ],
    },
  }))
  return { graph: { nodes, edges }, positions }
}

const build = (o: Partial<DiagramOptions>) => {
  const { graph, positions } = rowGraph()
  return buildDiagram(graph, {
    mode: "detailed",
    line: "cyclical",
    colorMode: "cable",
    measure: approxMeasure,
    positions,
    ...o,
  })
}

const arcsOf = (b: ReturnType<typeof build>) =>
  new Map(
    b.edges
      .filter((e) => (e.data as DiagramEdgeData).arc)
      .map((e) => [`${e.source.slice(4)}-${e.target.slice(4)}`, e])
  )

describe("Cyclical on the Diagram", () => {
  for (const mode of ["detailed", "simple"] as const)
    it(`${mode}: arcs the links over cards, bends the rest, crosses no card`, () => {
      const b = build({ mode })
      const arcs = arcsOf(b)
      expect([...arcs.keys()].sort()).toEqual([
        "r0-r3",
        "r0-r5",
        "r1-r4",
        "r2-r4",
      ])
      for (const e of arcs.values()) {
        const d = e.data as DiagramEdgeData
        // Both ends leave through the top: the side the arc bulges to.
        for (const a of [...d.a, ...d.b] as Anchor[])
          expect(a.k === "side" && a.side).toBe("T")
        expect(d.arc!.flip).toBe(-1)
        expect(d.arc!.h).toBeGreaterThan(0)
      }
      const cards = new Map(
        b.nodes.map((n) => [
          n.id,
          {
            x: n.position.x - n.width! / 2,
            y: n.position.y - n.height! / 2,
            w: n.width!,
            h: n.height!,
          },
        ])
      )
      const lines = drawn(b.nodes, b.edges, approxMeasure)
      expect(
        throughCards(
          lines.filter((c) =>
            arcs.has(`${c.source.slice(4)}-${c.target.slice(4)}`)
          ),
          cards
        )
      ).toEqual([])
      // The others keep their line: bendy, no arc.
      const beside = b.edges.find(
        (e) => e.source === "dev:r0" && e.target === "dev:r1"
      )!
      expect((beside.data as DiagramEdgeData).arc).toBeUndefined()
      expect((beside.data as DiagramEdgeData).plan![0].pts).toHaveLength(4)
    })

  it("nests the arcs leaving one side instead of crossing them", () => {
    const b = build({})
    const lines = drawn(b.nodes, b.edges, approxMeasure)
    const of = (s: string, t: string) =>
      lines.find((c) => c.source === `dev:${s}` && c.target === `dev:${t}`)!.pts
    for (const [x, y] of [
      [of("r0", "r5"), of("r0", "r3")],
      [of("r1", "r4"), of("r2", "r4")],
    ]) {
      let n = 0
      for (let i = 1; i < x.length; i++)
        for (let j = 1; j < y.length; j++)
          if (crosses(x[i - 1], x[i], y[j - 1], y[j])) n++
      expect(n).toBe(0)
    }
  })

  it("arcs a link's own cyclical line anywhere, to its saved side", () => {
    const b = build({
      line: "straight",
      links: {
        "r0|r1": { line: "cyclical" },
        "r2|r4": { line: "cyclical", flip: 1 },
      },
    })
    const arcs = arcsOf(b)
    expect([...arcs.keys()].sort()).toEqual(["r0-r1", "r2-r4"])
    const flipped = arcs.get("r2-r4")!.data as DiagramEdgeData
    expect(flipped.arc!.flip).toBe(1)
    for (const a of [...flipped.a, ...flipped.b] as Anchor[])
      expect(a.k === "side" && a.side).toBe("B")
  })

  it("follows a drag: an arc no longer needed goes back to its line", async () => {
    const { relinkDiagram } = await import("./build-diagram")
    const b = build({})
    // Lift r3 out of the row: r0-r3 has nothing to go round.
    const moved = b.nodes.map((n) =>
      n.id === "dev:r3" ? { ...n, position: { x: n.position.x, y: 400 } } : n
    )
    const re = relinkDiagram(b.model, moved)
    const e = re.edges.find(
      (x) => x.source === "dev:r0" && x.target === "dev:r3"
    )!
    expect((e.data as DiagramEdgeData).arc).toBeUndefined()
  })
})
