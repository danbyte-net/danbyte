// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { TopoEdge } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { fmt } from "@/lib/diagram/geometry"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { FAN_CABLE, FAN_DEV, fanoutGraph } from "../__fixtures__/fanout-graph"
import { boxOf } from "../__fixtures__/route-checks"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { detectFanouts } from "./fanout"
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
    // Two separate cables between fw-01 and core-c are still a "2x".
    const pair = b.edges.find(
      (e) => [e.source, e.target].sort().join() === [FW, CORE_C].sort().join()
    )!
    expect(data(pair).labels.mid).toEqual(["2x"])
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
