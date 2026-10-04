// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { TopoEdge } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { fmt } from "@/lib/diagram/geometry"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { FAN_CABLE, FAN_DEV, fanoutGraph } from "../__fixtures__/fanout-graph"
import { boxOf, drawn, throughCards } from "../__fixtures__/route-checks"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { detectFanouts, detectMeshes, portsLabel, sortPorts } from "./fanout"
import { toDocument } from "./to-document"
import type { DiagramCardData, DiagramEdgeData, DiagramMode } from "./types"

// A breakout cable - TEST, cat5e: fw-01 ethernet1/4 fanning out to three
// ports on core-b and two on asw-01 - is one trunk from its one port to a
// junction, then a leg to each far port. Never a "2x" bundle, never two
// nubs for one port.

const FW = `dev:${FAN_DEV.fw}`
const CORE_B = `dev:${FAN_DEV.coreB}`
const ASW = `dev:${FAN_DEV.asw}`
const CORE_C = `dev:${FAN_DEV.coreC}`
const J = `fan:${FAN_CABLE}`

const build = (mode: DiagramMode, o: Partial<DiagramOptions> = {}) =>
  buildDiagram(fanoutGraph, {
    mode,
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })

const data = (e: { data?: unknown }) => e.data as DiagramEdgeData
const nubPorts = (b: ReturnType<typeof build>, id: string) =>
  (b.nodes.find((n) => n.id === id)!.data as DiagramCardData).diagram.nubs.map(
    (u) => u.port
  )

describe("detectFanouts", () => {
  const present = () => true

  it("finds the one port a cable fans out from, and each far port", () => {
    const [fan, ...rest] = detectFanouts(fanoutGraph.edges, present)
    expect(rest).toHaveLength(0)
    expect(fan.id).toBe(J)
    expect(fan.trunk).toMatchObject({ node: FW, port: "ethernet1/4" })
    expect(fan.legs.map((l) => [l.node, l.port])).toEqual([
      [CORE_B, "Ethernet1/6"],
      [CORE_B, "Ethernet1/3"],
      [CORE_B, "Ethernet1/7"],
      [ASW, "Gi1/0/3"],
      [ASW, "Gi1/0/4"],
    ])
    expect(fan.edges).toHaveLength(2)
    // Every pair seen from the trunk's end.
    expect(fan.raw.pairs!.every((p) => p.a_port === "ethernet1/4")).toBe(true)
  })

  it("orients pairs from the trunk even when a payload edge runs the other way", () => {
    const flipped: TopoEdge[] = fanoutGraph.edges.map((e) =>
      e.data?.cable_id === FAN_CABLE && e.target === ASW
        ? {
            ...e,
            source: ASW,
            target: FW,
            data: {
              ...e.data,
              pairs: e.data.pairs!.map((p) => ({
                a: p.b,
                b: p.a,
                a_port: p.b_port,
                b_port: p.a_port,
                a_id: p.b_id,
                b_id: p.a_id,
              })),
            },
          }
        : e
    )
    const [fan] = detectFanouts(flipped, present)
    expect(fan.trunk.port).toBe("ethernet1/4")
    expect(fan.legs).toHaveLength(5)
    expect(fan.raw.pairs!.every((p) => p.a_port === "ethernet1/4")).toBe(true)
  })

  it("leaves a plain cable, and one with ports at both ends, alone", () => {
    const nm: TopoEdge = {
      id: "e:nm",
      source: FW,
      target: CORE_C,
      type: "cable",
      data: {
        cable_id: "nm",
        pairs: [
          { a: "fw:1", b: "c:1", a_port: "1", b_port: "1" },
          { a: "fw:1", b: "c:2", a_port: "1", b_port: "2" },
          { a: "fw:2", b: "c:1", a_port: "2", b_port: "1" },
          { a: "fw:2", b: "c:2", a_port: "2", b_port: "2" },
        ],
      },
    }
    const plain = fanoutGraph.edges.filter(
      (e) => e.data?.cable_id !== FAN_CABLE
    )
    expect(detectFanouts([...plain, nm], present)).toEqual([])
  })

  it("only counts cards on the map", () => {
    // With asw-01 off the map the cable still fans out to core-b.
    const fans = detectFanouts(fanoutGraph.edges, (id) => id !== ASW)
    expect(fans).toHaveLength(1)
    expect(fans[0].legs.map((l) => l.node)).toEqual([CORE_B, CORE_B, CORE_B])
  })
})

/** An MPO trunk broken out at both ends: fw-01 ports 1 and 2 on its A
 * end, core-c ports 1 and 2 on its B end, the payload edge running from
 * core-c (so every pair arrives B → A). */
const NM = "c0ffee00-fa00-4000-8000-0000000000aa"
function nmEdge(ends = true): TopoEdge {
  const pair = (c: string, f: string) => ({
    a: `core-c:${c}`,
    b: `fw-01:${f}`,
    a_port: c,
    b_port: f,
    ...(ends ? { a_end: "B" as const, b_end: "A" as const } : {}),
  })
  return {
    id: "e:nm",
    source: CORE_C,
    target: FW,
    type: "cable",
    data: {
      cable_id: NM,
      cable_label: "MPO-1",
      pairs: [pair("1", "1"), pair("1", "2"), pair("2", "1"), pair("2", "2")],
    },
  }
}

describe("detectMeshes", () => {
  it("groups each end's ports by the cable end the payload names", () => {
    const [m, ...rest] = detectMeshes([nmEdge()], () => true)
    expect(rest).toHaveLength(0)
    expect(m.id).toBe(`fan:${NM}`)
    expect(m.a.map((t) => [t.node, t.port])).toEqual([
      [FW, "1"],
      [FW, "2"],
    ])
    expect(m.b.map((t) => [t.node, t.port])).toEqual([
      [CORE_C, "1"],
      [CORE_C, "2"],
    ])
    // Every pair from the A end.
    expect(m.raw.pairs!.every((p) => p.a.startsWith("fw-01:"))).toBe(true)
    expect(m.a[0].pairs).toEqual([0, 2])
  })

  it("leaves the cable alone without the ends, or once it is a fan", () => {
    expect(detectMeshes([nmEdge(false)], () => true)).toEqual([])
    expect(detectMeshes([nmEdge()], () => true, new Set([NM]))).toEqual([])
    // A 1:N breakout is not one either.
    expect(detectMeshes(fanoutGraph.edges, () => true)).toEqual([])
  })
})

describe("an N:M breakout on the Diagram", () => {
  const graph = {
    ...fanoutGraph,
    edges: [
      ...fanoutGraph.edges.filter(
        (e) => ![e.source, e.target].includes(CORE_C)
      ),
      nmEdge(),
    ],
  }
  for (const mode of ["detailed", "simple"] as const)
    it(`${mode}: a trunk between two junctions, each end's ports on its own`, () => {
      const b = buildDiagram(graph, {
        mode,
        line: "elbow",
        colorMode: "cable",
        measure: approxMeasure,
      })
      const JA = `fan:${NM}`
      const JB = `${JA}:b`
      const mine = b.edges.filter((e) => data(e).cableId === NM)
      const trunk = mine.filter((e) => data(e).fan?.role === "trunk")
      expect(trunk.map((e) => [e.source, e.target])).toEqual([[JA, JB]])
      // The cable's name, on the trunk (or a leg when it is too short).
      expect(mine.flatMap((e) => data(e).labels.mid ?? [])).toContain("MPO-1")
      const legs = mine.filter((e) => data(e).fan?.role === "leg")
      const want =
        mode === "detailed"
          ? [
              [JA, FW],
              [JA, FW],
              [JB, CORE_C],
              [JB, CORE_C],
            ]
          : [
              [JA, FW],
              [JB, CORE_C],
            ]
      expect(legs.map((e) => [e.source, e.target]).sort()).toEqual(want.sort())
      // Both junctions sit between the two cards, the A one nearer fw-01.
      const at = (id: string) => b.nodes.find((n) => n.id === id)!.position
      const fw = at(FW)
      const core = at(CORE_C)
      const [ja, jb] = [at(JA), at(JB)]
      const t = (p: { x: number; y: number }) =>
        ((p.x - fw.x) * (core.x - fw.x) + (p.y - fw.y) * (core.y - fw.y)) /
        ((core.x - fw.x) ** 2 + (core.y - fw.y) ** 2)
      expect(t(ja)).toBeGreaterThan(0)
      expect(t(ja)).toBeLessThan(t(jb))
      expect(t(jb)).toBeLessThan(1)
      // Clicking a junction opens the cable: both know its trunk.
      for (const id of [JA, JB])
        expect(
          (b.nodes.find((n) => n.id === id)!.data as { trunk?: string }).trunk
        ).toBe(trunk[0].id)
      if (mode === "detailed")
        expect(
          nubPorts(b, FW).filter((p) => p === "1" || p === "2")
        ).toHaveLength(2)
      else
        // Each card's folded leg is named by its first port, both ends.
        for (const l of legs) {
          const end = data(l).b[0]
          expect(end.k === "side" && end.port).toBe("1 +1")
          expect(data(l).fan?.ports).toEqual(["1", "2"])
        }
    })
})

describe("sortPorts and portsLabel", () => {
  it("orders ports naturally and names a folded leg by its first", () => {
    const ports = sortPorts(["Ethernet1/6", "Ethernet1/10", "Ethernet1/3"])
    expect(ports).toEqual(["Ethernet1/3", "Ethernet1/6", "Ethernet1/10"])
    expect(portsLabel(ports)).toBe("Ethernet1/3 +2")
    expect(portsLabel(["Gi1/0/3"])).toBe("Gi1/0/3")
    expect(portsLabel([])).toBe("")
  })
})

describe("a breakout on the Diagram", () => {
  for (const line of ["elbow", "straight", "bendy"] as const)
    it(`Detailed · ${line}: one nub for the shared port, a leg to each far port`, () => {
      const b = build("detailed", { line })
      // One nub for ethernet1/4, whatever the cable reaches.
      expect(nubPorts(b, FW).filter((p) => p === "ethernet1/4")).toHaveLength(1)
      expect(nubPorts(b, CORE_B).sort()).toEqual(
        ["Ethernet1/1", "Ethernet1/3", "Ethernet1/6", "Ethernet1/7"].sort()
      )
      expect(nubPorts(b, ASW).filter((p) => p?.startsWith("Gi1/0/"))).toEqual(
        expect.arrayContaining(["Gi1/0/3", "Gi1/0/4"])
      )
      const fan = b.edges.filter((e) => data(e).cableId === FAN_CABLE)
      const trunk = fan.filter((e) => data(e).fan?.role === "trunk")
      const legs = fan.filter((e) => data(e).fan?.role === "leg")
      expect(trunk).toHaveLength(1)
      expect(trunk[0]).toMatchObject({ source: FW, target: J })
      expect(legs).toHaveLength(5)
      for (const l of legs) expect(l.source).toBe(J)
      // No count on a single cable: "Nx" only counts distinct cables.
      for (const e of b.edges)
        for (const m of data(e).labels.mid ?? []) expect(m).not.toMatch(/^\d+x/)
      // The trunk carries the cable's name and type (or hands it to a leg
      // when it is too short for it).
      expect(fan.flatMap((e) => data(e).labels.mid ?? [])).toContain(
        "TEST · cat5e"
      )
    })

  it("puts the junction off every card, ahead of its trunk's port", () => {
    for (const mode of ["detailed", "simple"] as const) {
      const b = build(mode)
      const j = b.nodes.find((n) => n.id === J)!
      expect(j.type).toBe("junction")
      expect(j.draggable).toBe(false)
      for (const n of b.nodes) {
        if (n.type !== "card") continue
        const r = boxOf(n)
        const inside =
          j.position.x > r.x - 8 &&
          j.position.x < r.x + r.w + 8 &&
          j.position.y > r.y - 8 &&
          j.position.y < r.y + r.h + 8
        expect(inside, `${mode}: junction on ${n.id}`).toBe(false)
      }
      const fw = boxOf(b.nodes.find((n) => n.id === FW)!)
      expect(j.position.x).toBeGreaterThan(fw.x + fw.w)
    }
  })

  it("Simple: the trunk, then one leg to each far card", () => {
    const b = build("simple")
    const fan = b.edges.filter((e) => data(e).cableId === FAN_CABLE)
    expect(fan.map((e) => [e.source, e.target]).sort()).toEqual(
      [
        [FW, J],
        [J, CORE_B],
        [J, ASW],
      ].sort()
    )
    // A leg folding three ports is named by the first in natural order;
    // the tooltip lists them all.
    const toCore = fan.find((e) => e.target === CORE_B)!
    expect(data(toCore).fan?.ports).toEqual([
      "Ethernet1/3",
      "Ethernet1/6",
      "Ethernet1/7",
    ])
    const end = data(toCore).b[0]
    expect(end.k === "side" && end.port).toBe("Ethernet1/3 +2")
    // Two separate cables between fw-01 and core-c are still a "2x".
    const pair = b.edges.find(
      (e) => [e.source, e.target].sort().join() === [FW, CORE_C].sort().join()
    )!
    expect(data(pair).labels.mid).toEqual(["2x"])
  })

  it("Bendy: a leg no curve gets clear of the cards goes round as an elbow", () => {
    // core-b squarely between the junction and asw-01: every fan curve
    // to asw-01 would run through it.
    const positions: Record<string, [number, number]> = {
      [FW]: [0, 0],
      [CORE_B]: [320, 0],
      [ASW]: [700, 0],
      [CORE_C]: [0, 260],
    }
    const b = build("detailed", { line: "bendy", positions })
    const legs = b.edges.filter(
      (e) => data(e).cableId === FAN_CABLE && e.target === ASW
    )
    expect(legs).toHaveLength(2)
    const plans = legs.flatMap((e) => data(e).plan ?? [])
    expect(plans.map((p) => p.line)).toEqual(["elbow", "elbow"])
    const cards = new Map(
      b.nodes.filter((n) => n.type === "card").map((n) => [n.id, boxOf(n)])
    )
    expect(throughCards(drawn(b.nodes, b.edges, approxMeasure), cards)).toEqual(
      []
    )
    // The legs to core-b, clear as curves, stay curves.
    const toCore = b.edges.filter(
      (e) => data(e).cableId === FAN_CABLE && e.target === CORE_B
    )
    for (const p of toCore.flatMap((e) => data(e).plan ?? []))
      expect(p.line).toBeUndefined()
  })

  it("re-places its junction when the trunk's card moves", () => {
    const b = build("detailed")
    const j0 = b.nodes.find((n) => n.id === J)!.position
    const moved = b.nodes.map((n) =>
      n.id === FW
        ? { ...n, position: { x: n.position.x, y: n.position.y + 400 } }
        : n
    )
    const re = relinkDiagram(b.model, moved)
    expect(re.junctions.get(J)!.y).not.toBeCloseTo(j0.y, 1)
  })
})

describe("a breakout in the exports", () => {
  const doc = (mode: DiagramMode) => {
    const b = build(mode)
    return toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "Fan", generated_at: "2026-09-26T12:00:00Z" },
      measure: approxMeasure,
      origin: "https://danbyte.example",
    })
  }

  it("is one junction, one trunk and a leg per far port, all one cable", () => {
    const d = doc("detailed")
    expect(d.junctions).toHaveLength(1)
    const [j] = d.junctions!
    expect(j).toMatchObject({ id: J, cable: FAN_CABLE })
    expect(j.link).toBe(`https://danbyte.example/cables/${FAN_CABLE}`)
    const fan = d.links.filter((l) => l.cable === FAN_CABLE)
    expect(fan).toHaveLength(6)
    expect(fan.filter((l) => l.target.node === J)).toHaveLength(1)
    expect(fan.filter((l) => l.source.node === J)).toHaveLength(5)
    for (const l of fan)
      expect(l.link).toBe(`https://danbyte.example/cables/${FAN_CABLE}`)
    // The legs start where the junction is drawn.
    for (const l of fan.filter((x) => x.source.node === J)) {
      expect(l.source.x).toBeCloseTo(j.x, 5)
      expect(l.source.y).toBeCloseTo(j.y, 5)
    }
    expect(toSvg(d, { measure: approxMeasure })).toContain(
      `<circle cx="${fmt(j.x)}" cy="${fmt(j.y)}" r="3"`
    )
  })

  it("folds its legs per far card in a Simple file of a Detailed map", () => {
    const b = build("detailed")
    const d = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      mode: "simple",
      meta: { title: "Fan", generated_at: "2026-09-26T12:00:00Z" },
      measure: approxMeasure,
    })
    const fan = d.links.filter((l) => l.cable === FAN_CABLE)
    expect(fan).toHaveLength(3)
    for (const l of d.links)
      for (const m of l.labels.mid ?? [])
        if (l.cable === FAN_CABLE) expect(m).not.toMatch(/^\d+x/)
  })

  it("is an ellipse its trunk ends on and its legs leave, in draw.io", () => {
    const xml = toDrawio([doc("detailed")], {
      mode: "detailed",
      measure: approxMeasure,
    })
    const dom = new DOMParser().parseFromString(xml, "text/xml")
    expect(dom.getElementsByTagName("parsererror")).toHaveLength(0)
    const ids = new Set<string>()
    const byId = new Map<string, Element>()
    for (const c of Array.from(dom.getElementsByTagName("mxCell"))) {
      const holder = c.parentElement?.tagName === "object" ? c.parentElement : c
      const id = holder.getAttribute("id")!
      expect(ids.has(id)).toBe(false)
      ids.add(id)
      byId.set(id, holder)
    }
    for (const c of Array.from(dom.getElementsByTagName("mxCell")))
      for (const a of ["parent", "source", "target"]) {
        const v = c.getAttribute(a)
        if (v) expect(ids.has(v), `${a} ${v}`).toBe(true)
      }
    const junction = [...byId.values()].find(
      (h) => h.getAttribute("danbyte_id") === J
    )!
    const cell = junction.getElementsByTagName("mxCell")[0]
    expect(cell.getAttribute("style")).toMatch(/^ellipse;/)
    const g = cell.getElementsByTagName("mxGeometry")[0]
    expect([g.getAttribute("width"), g.getAttribute("height")]).toEqual([
      "6",
      "6",
    ])
    expect(junction.getAttribute("danbyte_cable")).toBe(FAN_CABLE)
    const jid = junction.getAttribute("id")!
    const edges = Array.from(dom.getElementsByTagName("mxCell")).filter(
      (c) => c.getAttribute("edge") === "1"
    )
    const into = edges.filter((c) => c.getAttribute("target") === jid)
    const out = edges.filter((c) => c.getAttribute("source") === jid)
    expect(into).toHaveLength(1)
    expect(out).toHaveLength(5)
    for (const c of [...into, ...out])
      expect(c.parentElement!.getAttribute("danbyte_cable")).toBe(FAN_CABLE)
  })
})
