import { describe, expect, it } from "vitest"

import type { TopoEdge, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { aarhusGraph, aarhusPositions } from "../__fixtures__/aarhus-graph"
import { boxOf } from "../__fixtures__/route-checks"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import {
  chipCentre,
  inlineBox,
  LabelScene,
  placeInline,
} from "./label-placement"
import type { InlineAsk } from "./label-placement"
import { leaves, routeThrough } from "./link-geometry"
import { boxesOverlap, segHitsBox, turnedBox } from "./spatial"
import type { TurnedBox } from "./spatial"
import type { Anchor, DiagramEdgeData, LineType, Pt } from "./types"

// Where a Diagram's labels go: port names and end addresses sit ON their
// own line and off every other one, and no label - those or a middle chip
// - overlaps another or a card.

const measure = approxMeasure

/** The owner's Århus map with a /31 on every cable pair, dual-stack on
 * every other one. */
function withIps(g: TopologyGraph): TopologyGraph {
  let n = 0
  return {
    ...g,
    edges: g.edges.map((e): TopoEdge => {
      if (!e.data?.pairs) return e
      return {
        ...e,
        data: {
          ...e.data,
          pairs: e.data.pairs.map((p) => {
            n++
            const four = {
              cidr: `10.1.${n}.0/31`,
              family: 4 as const,
              a: `10.1.${n}.0`,
              b: `10.1.${n}.1`,
            }
            const six = {
              cidr: `2001:db8:${n}::/127`,
              family: 6 as const,
              a: `2001:db8:${n}::`,
              b: `2001:db8:${n}::1`,
            }
            return { ...p, subnets: n % 2 ? [four, six] : [four] }
          }),
        },
      }
    }),
  }
}

const build = (graph: TopologyGraph, o: Partial<DiagramOptions>) =>
  buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure,
    ...o,
  })

interface Placed {
  what: string
  box: TurnedBox
  /** An end label: the line it sits on. */
  on?: string
}

/** Every label a build placed, as boxes, and every drawn line. */
function scene(b: ReturnType<typeof build>) {
  const labels: Placed[] = []
  const lines: { edge: string; pts: Pt[] }[] = []
  for (const e of b.edges) {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) continue
    const routes = d.plan.map((p) => routeThrough(d.line, p.pts, leaves(p.pts)))
    routes.forEach((r, i) =>
      lines.push({
        edge: `${e.id}#${i}`,
        pts:
          d.line === "bendy" || d.line === "cyclical"
            ? Array.from({ length: 49 }, (_, k) => r.at(k / 48))
            : r.pts,
      })
    )
    d.plan.forEach((p, i) => {
      const on = `${e.id}#${i}`
      const add = (text: string, place: Pt & { rotate: number }) =>
        labels.push({
          what: `${text}@${on}`,
          box: inlineBox(place, measure(text, LABEL.END_SIZE, 400)),
          on,
        })
      for (const end of ["a", "b"] as const) {
        const anchor = d[end][i] as Anchor | undefined
        const place = p[end]
        if (place && anchor?.k === "side" && anchor.port)
          add(anchor.port, place)
        const ips = p.ips?.[end]
        const addr = d.labels.ends?.[i]?.[end]
        if (ips && addr) ips.forEach((at, k) => add(addr[k], at))
      }
    })
    const mid = (d.labels.mid ?? []).filter(Boolean)
    if (mid.length && !d.crowded) {
      const r = routes[Math.floor(routes.length / 2)]
      const c = chipCentre((t) => r.at(t), d.midT ?? 0.5, d.midOff ?? 0)
      const w =
        Math.max(...mid.map((m) => measure(m, LABEL.MID_SIZE, 600))) +
        2 * LABEL.PAD_X
      const h = mid.length * LABEL.MID_LH + 3
      labels.push({
        what: `chip ${mid[0]}`,
        box: turnedBox({ x: c.x - w / 2, y: c.y - h / 2, w, h }),
      })
    }
  }
  const cards = b.nodes
    .filter((n) => n.type === "card")
    .map((n) => ({ id: n.id, box: turnedBox(boxOf(n)) }))
  return { labels, lines, cards }
}

/** How far `p` lies from a polyline. */
function offLine(pts: readonly Pt[], p: Pt): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const [dx, dy] = [b.x - a.x, b.y - a.y]
    const l2 = dx * dx + dy * dy
    const u = l2
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
      : 0
    best = Math.min(best, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy))
  }
  return best
}

/** Labels over one another or over a card, end labels off their own line
 * or on another one. */
function faults(b: ReturnType<typeof build>): string[] {
  const { labels, lines, cards } = scene(b)
  const out: string[] = []
  // Shrunk a hair: boxes placed side by side may touch.
  const tight = (x: TurnedBox): TurnedBox => ({
    ...x,
    hw: x.hw - 0.5,
    hh: x.hh - 0.5,
  })
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++)
      if (boxesOverlap(tight(labels[i].box), tight(labels[j].box)))
        out.push(`${labels[i].what} over ${labels[j].what}`)
    for (const c of cards)
      if (boxesOverlap(tight(labels[i].box), c.box))
        out.push(`${labels[i].what} on ${c.id}`)
  }
  for (const l of labels) {
    if (!l.on) continue
    const own = lines.find((x) => x.edge === l.on)!
    // Curves are sampled: allow the chord's sag.
    if (offLine(own.pts, { x: l.box.cx, y: l.box.cy }) > 1.5)
      out.push(`${l.what} off its line`)
    for (const line of lines) {
      if (line.edge === l.on) continue
      for (let k = 1; k < line.pts.length; k++)
        if (segHitsBox(line.pts[k - 1], line.pts[k], tight(l.box))) {
          out.push(`${l.what} on ${line.edge}`)
          break
        }
    }
  }
  return out
}

describe("labels with addresses", () => {
  const graph = withIps(aarhusGraph)
  for (const mode of ["detailed", "simple"] as const)
    for (const line of ["elbow", "straight", "bendy", "cyclical"] as LineType[])
      for (const saved of [true, false])
        it(`${mode} · ${line}${saved ? " · saved" : ""}: nothing overlaps`, () => {
          const b = build(graph, {
            mode,
            line,
            ...(saved ? { positions: aarhusPositions } : {}),
          })
          expect(faults(b)).toEqual([])
          // Best effort: on the owner's arrangement most ends still get
          // their addresses; the compact automatic layout has less room.
          let asked = 0
          let shown = 0
          for (const e of b.edges)
            for (const p of (e.data as DiagramEdgeData | undefined)?.plan ?? [])
              for (const end of ["a", "b"] as const)
                if (p.ips && end in p.ips) {
                  asked++
                  if (p.ips[end]) shown++
                }
          expect(asked).toBeGreaterThan(10)
          // Simple's curves leave their shared point together and part late,
          // so fewer of their ends find a free stretch.
          const curved =
            mode === "simple" && line !== "elbow" && line !== "straight"
          expect(shown / asked).toBeGreaterThan(
            saved ? (curved ? 0.4 : 0.5) : 0.1
          )
        })

  it("Simple: an address sits out along its line, turned on a vertical run", () => {
    const up = "dev:10000000-0000-4000-8000-000000000001"
    const down = "dev:10000000-0000-4000-8000-000000000002"
    const b = build(
      {
        nodes: [up, down].map((id, i) => ({
          id,
          type: "device" as const,
          data: { name: `n${i}`, device_id: id.slice(4) },
        })),
        edges: [
          {
            id: "e:c:1:2",
            source: up,
            target: down,
            type: "cable",
            data: {
              cable_id: "c",
              pairs: [
                {
                  a: "n0:e1",
                  b: "n1:e1",
                  a_port: "e1",
                  b_port: "e1",
                  subnets: [
                    {
                      cidr: "10.0.0.0/31",
                      family: 4,
                      a: "10.0.0.0",
                      b: "10.0.0.1",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      {
        mode: "simple",
        line: "straight",
        positions: { [up]: [0, 0], [down]: [0, 300] },
      }
    )
    const d = b.edges[0].data as DiagramEdgeData
    const pts = d.plan![0].pts
    for (const [end, from] of [
      ["a", pts[0]],
      ["b", pts.at(-1)!],
    ] as const) {
      // The port name first, then the address further out, both on the
      // line and reading bottom to top.
      const port = d.plan![0][end]!
      const [ip] = d.plan![0].ips![end]!
      for (const place of [port, ip]) {
        expect(place.rotate).toBe(-90)
        expect(place.x).toBeCloseTo(from.x, 6)
      }
      const w = measure("e1", LABEL.END_SIZE, 400)
      const near = Math.abs(port.y - from.y)
      expect(near).toBeCloseTo(LABEL.LEAD + LABEL.GAP + w / 2, 6)
      expect(Math.abs(ip.y - from.y)).toBeGreaterThan(near + w / 2)
    }
  })
})

describe("end labels on their line", () => {
  /** Straight cables, as routes from their end, in a scene with them and
   * `cards`. */
  function lines(
    routes: Pt[][],
    cards: { x: number; y: number; w: number; h: number }[] = []
  ) {
    const sc = new LabelScene(
      routes.map((pts, i): [string, Pt[]] => [`c${i}`, pts]),
      cards
    )
    const ask = (
      i: number,
      ws: number[],
      o: Partial<InlineAsk> = {}
    ): InlineAsk => {
      const [p, q] = routes[i]
      const len = Math.hypot(q.x - p.x, q.y - p.y)
      const angle = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
      return {
        key: `c${i}`,
        cable: `c${i}`,
        ws,
        walk: (d) => ({
          x: p.x + ((q.x - p.x) * d) / len,
          y: p.y + ((q.y - p.y) * d) / len,
          angle,
        }),
        from: LABEL.LEAD,
        until: len / 2,
        ...o,
      }
    }
    return { sc, ask }
  }

  it("centres a name on its line, a lead and a gap out from the end", () => {
    const { sc, ask } = lines([
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
    ])
    const [place] = placeInline([ask(0, [40])], sc).get("c0")!.at
    expect(place).toEqual({ x: LABEL.LEAD + LABEL.GAP + 20, y: 0, rotate: 0 })
  })

  it("reads bottom to top on a line running down", () => {
    const { sc, ask } = lines([
      [
        { x: 0, y: 0 },
        { x: 0, y: 200 },
      ],
    ])
    const [place] = placeInline([ask(0, [40])], sc).get("c0")!.at
    expect(place.rotate).toBe(-90)
    expect(place.x).toBeCloseTo(0, 9)
  })

  it("puts each name side by side on its own line", () => {
    const ys = [0, 16, 32]
    const { sc, ask } = lines(
      ys.map((y) => [
        { x: 0, y },
        { x: 200, y },
      ])
    )
    const out = placeInline(
      ys.map((_, i) => ask(i, [50])),
      sc
    )
    ys.forEach((y, i) => {
      const [p] = out.get(`c${i}`)!.at
      expect(p.y).toBe(y)
      expect(p.x).toBeCloseTo(LABEL.LEAD + LABEL.GAP + 25, 9)
    })
  })

  it("slides out past a crossing line, and runs the addresses after the name", () => {
    const { sc, ask } = lines([
      [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
      ],
      [
        { x: 20, y: -50 },
        { x: 20, y: 50 },
      ],
    ])
    const out = placeInline([ask(0, [40, 60])], sc).get("c0")!
    const [port, ip] = out.at
    // Clear of the line at x = 20: the name's gap starts past it.
    expect(port.x - 20 - LABEL.GAP).toBeGreaterThan(20)
    expect(ip.x - port.x).toBeCloseTo(
      20 + LABEL.GAP + LABEL.LEAD + LABEL.GAP + 30,
      9
    )
    expect(out.reach).toBeCloseTo(ip.x + 30 + LABEL.GAP, 9)
  })

  it("keeps a port name to the run out of its nub", () => {
    // An elbow: 30 px out, then down.
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 200 },
    ]
    const sc = new LabelScene([["c0", pts]], [])
    const walk = (d: number) =>
      d <= 30 ? { x: d, y: 0, angle: 0 } : { x: 30, y: d - 30, angle: 90 }
    const ask: InlineAsk = {
      key: "c0",
      cable: "c0",
      ws: [40],
      walk,
      from: LABEL.LEAD,
      until: 115,
    }
    expect(placeInline([{ ...ask, first: true }], sc).get("c0")).toBeNull()
    // Anywhere along: past the bend, on the long run.
    const [p] = placeInline([ask], sc).get("c0")!.at
    expect(p.x).toBe(30)
    expect(p.rotate).toBe(-90)
  })

  it("leaves a label off rather than over a card or another label", () => {
    const { sc, ask } = lines(
      [
        [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
        [
          { x: 0, y: 20 },
          { x: 200, y: 20 },
        ],
      ],
      [{ x: 8, y: -20, w: 120, h: 30 }]
    )
    expect(placeInline([ask(0, [30])], sc).get("c0")).toBeNull()
    // The second line's name takes its spot; a wider one asked after it
    // on a line 8 px away could only overlap it.
    const sc2 = lines([
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
      ],
      [
        { x: 0, y: 8 },
        { x: 80, y: 8 },
      ],
    ])
    const out = placeInline([sc2.ask(0, [20]), sc2.ask(1, [20])], sc2.sc)
    expect(out.get("c0")).toBeTruthy()
    expect(out.get("c1")).toBeNull()
  })
})

/** The live breakout: aarhus-fw1:ethernet1/4 to three ports on
 * aalborg-core1 and two on aarhus-asw1, one cable. */
const FW = "50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76"
const ASW = "8d63e2cb-7feb-4370-a504-37a38d428570"
const AAL = "bc0ed74d-6e68-4476-8dd1-2d5b9fbb6318"
const CABLE = "2da1b108-1aab-4c85-a812-e2b5e5b9fbc2"
const liveFan: TopologyGraph = {
  nodes: [
    [FW, "aarhus-fw1", "#f59e0b"],
    [ASW, "aarhus-asw1", "#2563eb"],
    [AAL, "aalborg-core1", "#e11d48"],
  ].map(([id, name, color]) => ({
    id: `dev:${id}`,
    type: "device" as const,
    data: { name, device_id: id, role: { name, color } },
  })),
  edges: [
    [AAL, ["Ethernet1/6", "Ethernet1/3", "Ethernet1/7"]],
    [ASW, ["Gi1/0/3", "Gi1/0/4"]],
  ].map(([far, ports]) => ({
    id: `e:${CABLE}:${FW}:${far}`,
    source: `dev:${FW}`,
    target: `dev:${far as string}`,
    type: "cable",
    data: {
      cable_id: CABLE,
      cable_label: "TEST",
      cable_type: "cat5e",
      pairs: (ports as string[]).map((p) => ({
        a: `aarhus-fw1:ethernet1/4`,
        b: `x:${p}`,
        a_port: "ethernet1/4",
        b_port: p,
        a_end: "B" as const,
        b_end: "A" as const,
      })),
    },
  })),
}

describe("a breakout's legs converging on one card", () => {
  for (const direction of ["LR", "TB"] as const)
    it(`Bendy · ${direction}: every far port keeps its name`, () => {
      const b = build(liveFan, { line: "bendy", direction })
      const legs = b.edges.filter(
        (e) => (e.data as DiagramEdgeData).fan?.role === "leg"
      )
      expect(legs).toHaveLength(5)
      for (const e of legs) {
        const d = e.data as DiagramEdgeData
        expect(d.plan![0].b, e.id).toBeTruthy()
        // Each ends in a straight run as long as its name's stub, and
        // the name sits on it.
        const pts = d.plan![0].pts
        const [s, t] = [pts.at(-2)!, pts.at(-1)!]
        const p = pts.at(-3)!
        const cross = (s.x - p.x) * (t.y - p.y) - (s.y - p.y) * (t.x - p.x)
        expect(Math.abs(cross)).toBeLessThan(1e-6)
      }
      expect(faults(b)).toEqual([])
    })
})
