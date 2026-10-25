// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { ApplicationFlow, FlowEnd } from "@/lib/api"

import { toDrawio } from "./drawio"
import { buildFlowDocument, FLOW_LAYOUT } from "./flow-document"
import { arrowHeads, ARROW, trimForArrows } from "./geometry"
import { toSvg } from "./svg"
import type { DiagramDocument, DiagramLink } from "./types"

// An application's flows as a diagram (#163): the rank layout, the bands,
// the arrowed lines and their labels, and how the writers draw arrows.

const measure = (s: string) => s.length * 6
const AT = "2026-10-25T12:00:00Z"

const ip = (id: string, label: string, host?: string): FlowEnd => ({
  kind: "ip",
  id,
  label,
  device: host ? { id: `d-${host}`, name: host } : null,
  vm: null,
})
const prefix = (id: string, cidr: string): FlowEnd => ({
  kind: "prefix",
  id,
  label: cidr,
  device: null,
  vm: null,
})
const ANY: FlowEnd = {
  kind: "any",
  id: null,
  label: "Any",
  device: null,
  vm: null,
}

const app = (id: string, name: string) => ({ id, name, slug: id, path: name })
const SHOP = app("a1", "Shop")
const BILLING = app("a2", "Billing")

function flow(
  id: string,
  source: FlowEnd,
  destination: FlowEnd,
  over: Partial<ApplicationFlow> = {}
): ApplicationFlow {
  return {
    id,
    numid: null,
    application: SHOP,
    name: id,
    description: "",
    source,
    destination,
    protocol: "tcp",
    protocol_display: "TCP",
    ports: "443",
    direction: "one-way",
    status: null,
    service: null,
    ...over,
  } as ApplicationFlow
}

const WEB = ip("i-web", "10.1.0.10", "web1")
const APP = ip("i-app", "10.1.0.20", "app1")
const DB = ip("i-db", "10.2.0.5", "db1")
const NET = prefix("p-users", "192.0.2.0/24")

const shopFlows = [
  flow("users to web", NET, WEB),
  flow("web to app", WEB, APP, { ports: "8080" }),
  flow("app to db", APP, DB, { ports: "5432", direction: "both" }),
  flow("anyone to web", ANY, WEB, { protocol: "icmp", ports: "" }),
]

const build = (flows: ApplicationFlow[]) =>
  buildFlowDocument(flows, { title: "Shop", generatedAt: AT, measure })

const node = (doc: DiagramDocument, title: string) =>
  doc.nodes.find((n) => n.title === title)!

describe("buildFlowDocument", () => {
  it("is deterministic whatever order the flows come in", () => {
    const a = build(shopFlows)
    const b = build([...shopFlows].reverse())
    expect(b).toEqual(a)
    expect(toSvg(b, { measure })).toBe(toSvg(a, { measure }))
  })

  it("ranks sources left of their destinations", () => {
    const doc = build(shopFlows)
    const x = (t: string) => node(doc, t).x
    expect(x("192.0.2.0/24")).toBe(x("Any"))
    expect(x("192.0.2.0/24")).toBeLessThan(x("web1"))
    expect(x("web1")).toBeLessThan(x("app1"))
    expect(x("app1")).toBeLessThan(x("db1"))
    // Cards of one column do not overlap.
    const [p, a] = [node(doc, "192.0.2.0/24"), node(doc, "Any")]
    const [top, bottom] = p.y < a.y ? [p, a] : [a, p]
    expect(top.y + top.h + FLOW_LAYOUT.ROW_GAP).toBeLessThanOrEqual(
      bottom.y + 0.001
    )
  })

  it("titles an address with its device and keeps the address under it", () => {
    const doc = build(shopFlows)
    expect(node(doc, "web1").lines).toEqual(["10.1.0.10"])
    expect(node(doc, "192.0.2.0/24").lines).toEqual([])
    // One card per end: web1 is a destination and a source.
    expect(doc.nodes.filter((n) => n.title === "web1")).toHaveLength(1)
  })

  it("labels each line with its protocol and ports and arrows its direction", () => {
    const doc = build(shopFlows)
    const byId = new Map(doc.links.map((l) => [l.id, l]))
    expect(byId.get("flow:web to app")!.labels.mid).toEqual(["TCP 8080"])
    expect(byId.get("flow:anyone to web")!.labels.mid).toEqual(["ICMP"])
    expect(byId.get("flow:web to app")!.arrow).toBe("end")
    expect(byId.get("flow:app to db")!.arrow).toBe("both")
    const l = byId.get("flow:web to app")!
    expect(l.source.x).toBe(node(doc, "web1").x + node(doc, "web1").w)
    expect(l.target.x).toBe(node(doc, "app1").x)
  })

  it("draws one band per application, round its own cards", () => {
    const doc = build([
      ...shopFlows,
      flow("bill", WEB, DB, { application: BILLING }),
    ])
    expect(doc.bands.map((b) => b.label)).toEqual(["Billing", "Shop"])
    expect(doc.bands.every((b) => b.kind === "row")).toBe(true)
    const [billing, shop] = doc.bands
    expect(billing.y + billing.h).toBeLessThan(shop.y)
    for (const n of doc.nodes) {
      const band = n.id.startsWith("a2:") ? billing : shop
      expect(n.x).toBeGreaterThanOrEqual(band.x)
      expect(n.y).toBeGreaterThanOrEqual(band.y)
      expect(n.x + n.w).toBeLessThanOrEqual(band.x + band.w)
      expect(n.y + n.h).toBeLessThanOrEqual(band.y + band.h)
    }
    // An address in both applications is a card in each band.
    expect(doc.nodes.filter((n) => n.title === "web1")).toHaveLength(2)
  })

  it("spreads parallel lines and survives a cycle", () => {
    const doc = build([
      flow("a", WEB, APP),
      flow("b", WEB, APP, { ports: "8443" }),
      flow("back", APP, WEB, { ports: "9000" }),
    ])
    const ys = doc.links.map((l) => l.source.y)
    expect(new Set(ys).size).toBe(3)
    expect(node(doc, "web1").x).toBeLessThan(node(doc, "app1").x)
    const back = doc.links.find((l) => l.id === "flow:back")!
    // Against the ranks: from the left edge to the right edge.
    expect(back.source.side).toBe("left")
    expect(back.target.side).toBe("right")
  })
})

describe("arrowheads", () => {
  const line: DiagramLink = {
    id: "l",
    kind: "straight",
    sem: "cable",
    source: { node: "a", x: 0, y: 50 },
    target: { node: "b", x: 100, y: 50 },
    points: [],
    stroke: "#71717b",
    width: 1,
    labels: {},
    arrow: "end",
  }

  it("put the tip on the end and the base a head's length back", () => {
    const [head] = arrowHeads(line)
    const len = ARROW.LEN + ARROW.PER_WIDTH
    const half = ARROW.HALF + ARROW.PER_WIDTH / 2
    expect(head).toEqual([
      { x: 100, y: 50 },
      { x: 100 - len, y: 50 + half },
      { x: 100 - len, y: 50 - half },
    ])
    expect(arrowHeads({ ...line, arrow: "both" })).toHaveLength(2)
    expect(arrowHeads({ ...line, arrow: "none" })).toEqual([])
    expect(arrowHeads({ ...line, arrow: undefined })).toEqual([])
    // The line stops inside the head, short of its tip.
    const t = trimForArrows(line).target
    expect(t.x).toBeLessThan(100)
    expect(t.x).toBeGreaterThan(100 - len)
  })

  it("are polygons in the SVG and block arrows in draw.io", () => {
    const doc = build(shopFlows)
    const svg = toSvg(doc, { measure })
    expect(svg).not.toContain("<marker")
    // One head per one-way flow, two for the flow both ways.
    expect(svg.match(/<polygon /g)).toHaveLength(5)
    const xml = toDrawio([doc], { mode: "simple" })
    expect(xml).toContain("endArrow=block;endFill=1;startArrow=none;")
    expect(xml).toContain(
      "endArrow=block;endFill=1;startArrow=block;startFill=1;"
    )
  })
})
