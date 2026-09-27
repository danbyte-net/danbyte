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
  endBox,
  LabelScene,
  placePortLabels,
  portBox,
} from "./label-placement"
import type { PortLabelAsk } from "./label-placement"
import { leaves, routeThrough } from "./link-geometry"
import { boxesOverlap, segHitsBox, turnedBox } from "./spatial"
import type { TurnedBox } from "./spatial"
import type { Anchor, DiagramEdgeData, LineType, Pt } from "./types"

// Where a Diagram's labels go: port names, middle chips and end addresses
// never overlap each other or a card, addresses keep off every line, and a
// card side's names share its gaps one to a gap.

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
      for (const end of ["a", "b"] as const) {
        const anchor = d[end][i] as Anchor | undefined
        const place = p[end]
        if (place && anchor?.k === "side" && anchor.port)
          labels.push({
            what: `${anchor.port}@${e.id}#${i}`,
            box: portBox(place, measure(anchor.port, LABEL.END_SIZE, 400)),
          })
        const ip = p.ips?.[end]
        const addr = d.labels.ends?.[i]?.[end]
        if (ip && addr) {
          const w = Math.max(
            ...addr.map((t) => measure(t, LABEL.END_SIZE, 400))
          )
          labels.push({
            what: `${addr[0]}@${e.id}#${i}`,
            box: endBox(ip, w, addr.length),
          })
        }
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

/** Labels over one another or over a card, and addresses on a line. */
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
    if (!/^[0-9a-f:.]+@/.test(l.what)) continue
    for (const line of lines)
      for (let k = 1; k < line.pts.length; k++)
        if (segHitsBox(line.pts[k - 1], line.pts[k], tight(l.box))) {
          out.push(`${l.what} on ${line.edge}`)
          break
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
          expect(shown / asked).toBeGreaterThan(saved ? 0.5 : 0.1)
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
      const place = d.plan![0].ips![end]!
      expect(place.rotate).toBe(-90)
      const w = measure(d.labels.ends![0][end]![0], LABEL.END_SIZE, 400)
      // The block's near end is END_DIST or more along the line.
      expect(Math.abs(place.y - from.y) - w / 2).toBeGreaterThanOrEqual(
        LABEL.END_DIST - 0.5
      )
    }
  })
})

describe("port names on one card side", () => {
  /** Three cables leaving a card's right side 16 px apart, a card right
   * above the top one: four gaps, the top one closed. */
  function side() {
    const ys = [0, 16, 32]
    const sc = new LabelScene(
      ys.map((y, i): [string, Pt[]] => [
        `c${i}`,
        [
          { x: 0, y },
          { x: 200, y },
        ],
      ]),
      [{ x: 0, y: -40, w: 200, h: 37 }]
    )
    const ask = (i: number, prefer: 1 | -1): PortLabelAsk => ({
      key: `c${i}`,
      cable: `c${i}`,
      text: `Ethernet1/${i}`,
      w: 50,
      start: { x: 0, y: ys[i] },
      angle: 0,
      room: 90,
      side: prefer,
      group: "card\u0000R",
    })
    return { sc, ask }
  }

  it("seats every name one to a gap where the first pass could not", () => {
    const { sc, ask } = side()
    // The middle cable goes first and takes the gap above it - the only
    // one the top cable has.
    const asks = [ask(1, -1), ask(0, 1), ask(2, 1)]
    const out = placePortLabels(asks, sc)
    expect([...out.values()].every(Boolean)).toBe(true)
    const ys = asks.map((a) => out.get(a.key)!.y).sort((x, y) => x - y)
    // One in each open gap: between 0 and 16, 16 and 32, below 32.
    expect(ys[0]).toBeGreaterThan(0)
    expect(ys[0]).toBeLessThan(16)
    expect(ys[1]).toBeGreaterThan(16)
    expect(ys[1]).toBeLessThan(32)
    expect(ys[2]).toBeGreaterThan(32)
  })

  it("keeps the first pass where it already seated every name", () => {
    const { sc, ask } = side()
    const asks = [ask(0, 1), ask(1, 1), ask(2, 1)]
    const out = placePortLabels(asks, sc)
    for (const a of asks) expect(out.get(a.key)!.y).toBeGreaterThan(a.start.y)
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
        // Each ends in a straight run as long as its name's stub.
        const pts = d.plan![0].pts
        const [s, t] = [pts.at(-2)!, pts.at(-1)!]
        const p = pts.at(-3)!
        const cross = (s.x - p.x) * (t.y - p.y) - (s.y - p.y) * (t.x - p.x)
        expect(Math.abs(cross)).toBeLessThan(1e-6)
      }
      expect(faults(b)).toEqual([])
    })
})
