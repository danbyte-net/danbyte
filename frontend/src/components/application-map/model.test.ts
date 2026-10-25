// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type {
  Application,
  ApplicationFlow,
  FlowEnd,
  InstalledSoftware,
  StatusMini,
} from "@/lib/api"
import { toSvg } from "@/lib/diagram/svg"
import { toDrawio } from "@/lib/diagram/drawio"

import { appMapDocument } from "./document"
import {
  applicationColor,
  decodePositions,
  encodePositions,
  flowArrow,
  flowLabels,
  flowPaint,
  flowsGraph,
  levelLabels,
  matchCards,
  treeGraph,
  withPositions,
  withoutHidden,
} from "./model"
import { flowsPath, movedFrom, NO_FILTERS } from "./use-app-map"

// The Application map's model (#163): the Tree's rows and hosts, the
// Flows' card pairs with their arrows, colours and labels, hand-moved
// cards, and the export document both views draw from.

const measure = (s: string) => s.length * 6

function application(
  id: string,
  name: string,
  parent: Application | null = null,
  over: Partial<Application> = {}
): Application {
  return {
    id,
    numid: null,
    name,
    slug: id,
    path: parent ? `${parent.path} › ${name}` : name,
    depth: 0,
    parent: parent ? { id: parent.id, name: parent.name } : null,
    manufacturer: null,
    eol_source: "",
    eol_product: "",
    eol: null,
    description: "",
    tags: [],
    custom_fields: {},
    install_count: 0,
    child_count: 0,
    flow_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  }
}

const PAY = application("pay", "Payments")
const CHECKOUT = application("checkout", "Checkout", PAY)
const API = application("api", "checkout-api", CHECKOUT, {
  install_count: 2,
  flow_count: 1,
})
const PG = application("pg", "PostgreSQL", CHECKOUT, { install_count: 1 })
const LONE = application("lone", "nginx")
const APPS = [PAY, CHECKOUT, API, PG, LONE]

function install(
  id: string,
  app: Application,
  host: { device?: string; vm?: string }
): InstalledSoftware {
  return {
    id,
    numid: null,
    application: { id: app.id, name: app.name, slug: app.slug, path: app.path },
    device: host.device ? { id: host.device, name: host.device } : null,
    virtual_machine: host.vm ? { id: host.vm, name: host.vm } : null,
    version: "1",
    description: "",
    tags: [],
    custom_fields: {},
  } as unknown as InstalledSoftware
}

const INSTALLS = [
  install("i1", API, { device: "web1" }),
  install("i2", API, { vm: "vm1" }),
  install("i3", PG, { device: "web1" }),
]

const ip = (id: string, label: string, host?: string): FlowEnd => ({
  kind: "ip",
  id,
  label,
  device: host ? { id: `d-${host}`, name: host } : null,
  vm: null,
})
const ACTIVE: StatusMini = {
  id: "s1",
  name: "Active",
  slug: "active",
  color: "16a34a",
  text_color: "#fff",
}
const PLANNED: StatusMini = {
  id: "s2",
  name: "Planned",
  slug: "planned",
  color: "#f59e0b",
  text_color: "#000",
}
const RETIRED: StatusMini = {
  id: "s3",
  name: "Retired",
  slug: "retired",
  color: "#71717a",
  text_color: "#fff",
}

const SHOP = { id: "shop", name: "Shop", slug: "shop", path: "Shop" }

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
    direction_display: "One way",
    status: ACTIVE,
    service: null,
    tags: [],
    ...over,
  } as ApplicationFlow
}

const WEB = ip("i-web", "10.1.0.10", "web1")
const DB = ip("i-db", "10.2.0.5", "db1")

describe("treeGraph", () => {
  const g = treeGraph(APPS, INSTALLS, { measure })
  const node = (id: string) => g.nodes.find((n) => n.id === id)!

  it("draws an application card per application with its counts", () => {
    expect(
      g.nodes.filter((n) => n.data.ref.kind === "application")
    ).toHaveLength(5)
    expect(node("app:api").data.input.lines[0].text).toBe("2 installs · 1 flow")
    expect(node("app:api").type).toBe("card")
  })

  it("puts each depth in its own row band, and the hosts in the last", () => {
    expect(g.bands.map((b) => b.label)).toEqual([
      "Domains",
      "Processes",
      "Applications",
      "Hosts",
    ])
    const y = (id: string) => node(id).position.y
    expect(y("app:pay")).toBe(y("app:lone"))
    expect(y("app:checkout")).toBeGreaterThan(y("app:pay"))
    expect(y("app:api")).toBe(y("app:pg"))
    expect(y("host:device:web1")).toBeGreaterThan(y("app:api"))
    expect(y("host:vm:vm1")).toBe(y("host:device:web1"))
    // Every card inside its row.
    for (const n of g.nodes) {
      const band = g.bands.find(
        (b) => n.position.y > b.y && n.position.y < b.y + b.h
      )
      expect(band, n.id).toBeTruthy()
    }
  })

  it("links parents to children and applications to their hosts", () => {
    const ids = g.edges.map((e) => `${e.source}>${e.target}`).sort()
    expect(ids).toEqual(
      [
        "app:pay>app:checkout",
        "app:checkout>app:api",
        "app:checkout>app:pg",
        "app:api>host:device:web1",
        "app:api>host:vm:vm1",
        "app:pg>host:device:web1",
      ].sort()
    )
    const line = g.edges.find((e) => e.data!.kind === "install")!
    expect(line.style?.strokeDasharray).toBe("4 3")
    expect(line.markerEnd).toBeUndefined()
  })

  it("dashes a VM's card, as the Logical tab does", () => {
    expect(node("host:vm:vm1").data.panel).toBe(true)
    expect(node("host:device:web1").data.panel).toBeUndefined()
  })

  it("leaves the hosts out when Hosts is off", () => {
    const off = treeGraph(APPS, INSTALLS, { measure, hosts: false })
    expect(off.nodes.some((n) => n.data.ref.kind === "host")).toBe(false)
    expect(off.bands.map((b) => b.label)).not.toContain("Hosts")
  })

  it("keeps a picked application with its ancestors and descendants", () => {
    const one = treeGraph(APPS, INSTALLS, {
      measure,
      applications: ["checkout"],
      hosts: false,
    })
    expect(one.nodes.map((n) => n.id).sort()).toEqual(
      ["app:api", "app:checkout", "app:pay", "app:pg"].sort()
    )
  })

  it("keeps the applications installed on a host", () => {
    const on = treeGraph(APPS, INSTALLS, {
      measure,
      host: "vm:vm1",
      hosts: false,
    })
    expect(on.nodes.map((n) => n.id).sort()).toEqual(
      ["app:api", "app:checkout", "app:pay"].sort()
    )
  })

  it("names rows by depth", () => {
    expect(levelLabels(1)).toEqual(["Applications"])
    expect(levelLabels(2)).toEqual(["Level 1", "Level 2"])
  })

  it("fills a card with its first coloured tag, else none", () => {
    expect(applicationColor({ tags: [] })).toBeNull()
    expect(
      applicationColor({
        tags: [
          { id: 1, name: "a", slug: "a", color: "", text_color: "" },
          { id: 2, name: "b", slug: "b", color: "0ea5e9", text_color: "" },
        ],
      })
    ).toBe("#0ea5e9")
  })
})

describe("flowsGraph", () => {
  it("draws one line per pair of ends, labelled with every service", () => {
    const g = flowsGraph(
      [
        flow("a", WEB, DB, { ports: "5432" }),
        flow("b", WEB, DB, { ports: "6432" }),
      ],
      { measure }
    )
    expect(g.nodes.map((n) => n.data.name).sort()).toEqual(["db1", "web1"])
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0].data!.labels.mid).toEqual(["TCP 5432", "TCP 6432"])
    expect(g.edges[0].data!.flows).toHaveLength(2)
    expect(g.bands.map((b) => b.label)).toEqual(["Shop"])
  })

  it("arrows a line the way its flows run", () => {
    const keyOf = (f: ApplicationFlow, side: "source" | "destination") =>
      f[side].id!
    expect(flowArrow([flow("a", WEB, DB)], "i-web", keyOf)).toBe("end")
    expect(flowArrow([flow("a", DB, WEB)], "i-web", keyOf)).toBe("start")
    expect(
      flowArrow([flow("a", WEB, DB), flow("b", DB, WEB)], "i-web", keyOf)
    ).toBe("both")
    expect(
      flowArrow([flow("a", WEB, DB, { direction: "both" })], "i-web", keyOf)
    ).toBe("both")
    const g = flowsGraph([flow("a", WEB, DB)], { measure })
    expect(g.edges[0].markerEnd).toBeTruthy()
    expect(g.edges[0].markerStart).toBeUndefined()
  })

  it("colours by status: dashed when planned, faded when retired", () => {
    expect(flowPaint([flow("a", WEB, DB)]).stroke).toBe("#16a34a")
    expect(
      flowPaint([flow("a", WEB, DB), flow("b", WEB, DB, { status: PLANNED })])
        .stroke
    ).toBeUndefined()
    expect(flowPaint([flow("a", WEB, DB, { status: PLANNED })]).dash).toBe(
      "6 4"
    )
    expect(flowPaint([flow("a", WEB, DB, { status: RETIRED })]).faded).toBe(
      true
    )
  })

  it("counts the services past three", () => {
    const many = ["1", "2", "3", "4"].map((p) => flow(p, WEB, DB, { ports: p }))
    expect(flowLabels(many)).toEqual(["TCP 1", "TCP 2", "+2"])
  })

  it("draws no line for a flow from an address to itself", () => {
    const g = flowsGraph([flow("a", WEB, WEB)], { measure })
    expect(g.edges).toHaveLength(0)
  })
})

describe("positions, hiding and search", () => {
  const g = treeGraph(APPS, INSTALLS, { measure, hosts: false })

  it("round-trips moved cards through the URL", () => {
    const moved = { "app:pay": [10, -20] as [number, number] }
    expect(decodePositions(encodePositions(moved))).toEqual(moved)
    expect(decodePositions("junk,app:x~1")).toEqual({})
    const at = withPositions(g, moved)
    expect(at.nodes.find((n) => n.id === "app:pay")!.position).toEqual({
      x: 10,
      y: -20,
    })
  })

  it("keeps only the cards a drag moved", () => {
    const centres = Object.fromEntries(
      g.nodes.map((n) => [n.id, [n.position.x, n.position.y]])
    ) as Record<string, [number, number]>
    centres["app:pg"] = [1, 2]
    expect(movedFrom(g, centres)).toEqual({ "app:pg": [1, 2] })
  })

  it("hides a card with its lines", () => {
    const h = withoutHidden(g, new Set(["app:checkout"]))
    expect(h.nodes.some((n) => n.id === "app:checkout")).toBe(false)
    expect(
      h.edges.some(
        (e) => e.source === "app:checkout" || e.target === "app:checkout"
      )
    ).toBe(false)
  })

  it("matches cards by name and path", () => {
    expect(matchCards(g.nodes, "")).toBeNull()
    expect([...matchCards(g.nodes, "postgres")!]).toEqual(["app:pg"])
    expect(matchCards(g.nodes, "payments checkout")!.has("app:api")).toBe(true)
  })

  it("asks the server for what it filters", () => {
    expect(flowsPath(NO_FILTERS)).toBe("/api/application-flows/")
    expect(
      flowsPath({
        ...NO_FILTERS,
        applications: ["a"],
        status: "s",
        protocol: "tcp",
        host: "vm:v",
      })
    ).toBe("/api/application-flows/?application=a&status=s&protocol=tcp&vm=v")
    expect(
      flowsPath({ ...NO_FILTERS, applications: ["a", "b"], host: "device:d" })
    ).toBe("/api/application-flows/?device=d")
  })
})

describe("appMapDocument", () => {
  const meta = {
    title: "Application map",
    generated_at: "2026-10-25T12:00:00Z",
  }

  it("exports the Tree's cards, rows and lines from where they stand", () => {
    const g = withPositions(treeGraph(APPS, INSTALLS, { measure }), {
      "app:lone": [900, 40],
    })
    const doc = appMapDocument(g, {
      meta,
      origin: "https://d.example",
      measure,
    })
    expect(doc.nodes).toHaveLength(g.nodes.length)
    const lone = doc.nodes.find((n) => n.id === "app:lone")!
    expect(lone.x + lone.w / 2).toBe(900)
    expect(lone.link).toBe("https://d.example/applications/lone")
    expect(doc.bands.map((b) => b.label)).toContain("Hosts")
    expect(doc.links).toHaveLength(g.edges.length)
    expect(doc.links.find((l) => l.id.startsWith("install:"))!.dash).toBe("4 3")
    // The print theme: no CSS variables reach a file.
    for (const l of doc.links) expect(l.stroke).toMatch(/^#[0-9a-f]{6}$/)
    expect(toSvg(doc)).toContain("Payments")
  })

  it("exports the Flows' arrows, colours and labels", () => {
    const g = flowsGraph(
      [
        flow("in", DB, WEB, { status: PLANNED }),
        flow("old", WEB, ip("i-x", "10.9.9.9"), { status: RETIRED }),
      ],
      { measure }
    )
    const doc = appMapDocument(g, { meta, measure })
    const planned = doc.links.find((l) => l.dash === "6 4")!
    expect(planned.stroke).toBe("#f59e0b")
    expect(planned.arrow).toBe("end")
    // The arrow points at the destination, whichever end the line began.
    expect(planned.target.node).toBe(`shop:ip:i-web`)
    expect(planned.labels.mid).toEqual(["TCP 443"])
    const old = doc.links.find((l) => l.id !== planned.id)!
    expect(old.stroke).not.toBe("#71717a")
    expect(toSvg(doc)).toContain("TCP 443")
    expect(toDrawio([doc], { mode: "simple" })).toContain("endArrow")
  })
})
