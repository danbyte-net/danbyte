// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type {
  Application,
  ApplicationFlow,
  FlowEnd,
  InstalledSoftware,
} from "@/lib/api"
import { LABEL } from "@/lib/diagram/theme"
import { chipCentre } from "@/components/topology/diagram/label-placement"
import type { Pt, Rect } from "@/components/topology/diagram/types"

import { toFlow } from "./app-map-canvas"
import {
  flowsGraph,
  focusSet,
  packRow,
  treeGraph,
  withPositions,
} from "./model"
import type { AppMapGraph } from "./model"
import { appSlots, boxOf, orthoPath, plannedRoute, samples } from "./routing"

// The Application map's lines (#163): each application's install lines in
// a channel of its own above the Hosts row, meeting a host at the
// application's own point; the hosts under their applications; the focus
// a hover brings; and no line (or label) on a card it does not join, in
// either view.

const measure = (s: string) => s.length * 6

function app(id: string, name = id, over: Partial<Application> = {}) {
  return {
    id,
    numid: null,
    name,
    slug: id,
    path: name,
    depth: 0,
    parent: null,
    manufacturer: null,
    eol_source: "",
    eol_product: "",
    eol: null,
    description: "",
    tags: [],
    custom_fields: {},
    install_count: 1,
    child_count: 0,
    flow_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Application
}

function install(
  id: string,
  a: Application,
  device: string,
  version = "1.0"
): InstalledSoftware {
  return {
    id,
    application: { id: a.id, name: a.name, slug: a.slug, path: a.path },
    device: { id: device, name: device },
    virtual_machine: null,
    version,
  } as unknown as InstalledSoftware
}

// The owner's screen: three hosts under a row of applications, most
// hosts running several.
const NAMES = [
  "Python",
  "Danbyte",
  "Postgres",
  "nginx",
  "Redis",
  "Terraform",
  "Ansible",
  "Vault",
  "Grafana",
]
const APPS = NAMES.map((n) => app(n.toLowerCase(), n))
const by = (n: string) => APPS.find((a) => a.name === n)!
const INSTALLS = [
  ...["Python", "Danbyte", "Postgres", "nginx", "Redis"].map((n, i) =>
    install(`d1-${i}`, by(n), "db-dev01", `${i + 1}.0`)
  ),
  ...["Python", "Danbyte", "Postgres", "nginx", "Redis"].map((n, i) =>
    install(`d2-${i}`, by(n), "db-ipam", `${i + 2}.1`)
  ),
  ...["Python", "Terraform", "Ansible"].map((n, i) =>
    install(`tf-${i}`, by(n), "tf-01", `${i + 3}.2`)
  ),
  install("v1", by("Vault"), "db-vault", "1.17"),
  install("g1", by("Grafana"), "db-mon", "11.2"),
]

const inside = (p: Pt, r: Rect, pad = 0) =>
  p.x > r.x - pad &&
  p.x < r.x + r.w + pad &&
  p.y > r.y - pad &&
  p.y < r.y + r.h + pad

/** Every line's drawn route sampled against every card it does not join:
 * the points that land on one. */
function collisions(g: AppMapGraph): string[] {
  const boxes = new Map(g.nodes.map((n) => [n.id, boxOf(n)]))
  const out: string[] = []
  for (const e of g.edges) {
    const route = plannedRoute(e)
    expect(route, e.id).toBeTruthy()
    for (const p of samples(route!))
      for (const [id, r] of boxes)
        if (id !== e.source && id !== e.target && inside(p, r))
          out.push(`${e.id} crosses ${id}`)
  }
  return [...new Set(out)]
}

/** A line's horizontal run in the Hosts gap. */
function channelY(g: AppMapGraph, id: string): number {
  const gap = g.hostGap!
  const pts = g.edges.find((e) => e.id === id)!.data!.plan![0].pts
  for (let i = 1; i < pts.length; i++)
    if (
      pts[i].y === pts[i - 1].y &&
      pts[i].y > gap.top - 1 &&
      pts[i].y < gap.bottom + 1
    )
      return pts[i].y
  // A line straight down into its host has no run: its drop is its slot.
  return NaN
}

describe("Tree host lines", () => {
  const g = treeGraph(APPS, INSTALLS, { measure })
  const installs = g.edges.filter((e) => e.data!.kind === "install")
  const node = (id: string) => g.nodes.find((n) => n.id === id)!

  it("gives each application its own channel in the Hosts gap", () => {
    expect(g.hostGap).toBeTruthy()
    const perApp = new Map<string, Set<number>>()
    for (const e of installs) {
      const y = channelY(g, e.id)
      if (Number.isNaN(y)) continue
      const s = perApp.get(e.source) ?? new Set()
      s.add(y)
      perApp.set(e.source, s)
    }
    // One application's lines run as one bundle…
    for (const [, ys] of perApp) expect(ys.size).toBe(1)
    // …and no two applications share a channel.
    const all = [...perApp.values()].map((s) => [...s][0])
    expect(new Set(all).size).toBe(all.length)
  })

  it("spreads the slots evenly, one per application", () => {
    const slots = appSlots(["a", "b", "c", "d"], { top: 100, bottom: 140 })
    expect([...slots.values()]).toEqual([105, 115, 125, 135])
    expect(new Set(slots.values()).size).toBe(4)
    expect(appSlots(["a"], undefined).size).toBe(0)
  })

  it("meets a host at a point of each application's own", () => {
    for (const host of ["db-dev01", "db-ipam", "tf-01"]) {
      const id = `host:device:${host}`
      const ends = installs
        .filter((e) => e.target === id)
        .map((e) => ({ x: e.data!.plan![0].pts.at(-1)!.x, src: e.source }))
      expect(new Set(ends.map((e) => e.x)).size).toBe(ends.length)
      // In the applications' order left to right, so the fan-in does not
      // cross itself.
      const sorted = [...ends].sort((a, b) => a.x - b.x)
      const appX = sorted.map((e) => node(e.src).position.x)
      expect(appX).toEqual([...appX].sort((a, b) => a - b))
      // On the host's top edge.
      const top = boxOf(node(id)).y
      for (const e of installs.filter((x) => x.target === id))
        expect(e.data!.plan![0].pts.at(-1)!.y).toBe(top)
    }
  })

  it("dashes the lines and draws them as elbows", () => {
    for (const e of installs) {
      expect(e.style?.strokeDasharray).toBe("4 3")
      expect(e.data!.plan![0].line).toBe("elbow")
    }
  })

  it("puts a host of one application right under it, the rest by their mean", () => {
    expect(node("host:device:db-vault").position.x).toBe(
      node("app:vault").position.x
    )
    expect(node("host:device:db-mon").position.x).toBe(
      node("app:grafana").position.x
    )
    const mean = (host: string) => {
      const xs = installs
        .filter((e) => e.target === `host:device:${host}`)
        .map((e) => node(e.source).position.x)
      return xs.reduce((s, x) => s + x, 0) / xs.length
    }
    const hosts = ["db-dev01", "db-ipam", "tf-01", "db-vault", "db-mon"]
    const byMean = [...hosts].sort((a, b) => mean(a) - mean(b))
    const byX = [...hosts].sort(
      (a, b) =>
        node(`host:device:${a}`).position.x -
        node(`host:device:${b}`).position.x
    )
    expect(byX).toEqual(byMean)
  })

  it("packs a row without overlaps, each as near its want as it can", () => {
    const at = packRow(
      [
        { key: "a", w: 100, want: 0 },
        { key: "b", w: 100, want: 10 },
        { key: "c", w: 40, want: 500 },
      ],
      20
    )
    expect(at.get("b")! - at.get("a")!).toBe(120)
    // The pushed pair centred on their wants' mean.
    expect((at.get("a")! + at.get("b")!) / 2).toBe(5)
    expect(at.get("c")).toBe(500)
  })

  it("names the application and version on a line's hover", () => {
    const e = installs.find(
      (x) => x.id === "install:redis:host:device:db-ipam"
    )!
    expect(e.data!.tip).toBe("Redis · 6.1")
  })

  it("crosses no card it does not join", () => {
    expect(collisions(g)).toEqual([])
    // Nor once a card is dragged into the lines' way.
    const db = node("host:device:db-dev01")
    const moved = withPositions(g, {
      "app:terraform": [db.position.x, (g.hostGap!.top + db.position.y) / 2],
    })
    expect(collisions(moved)).toEqual([])
  })
})

describe("Hosts under applications", () => {
  const g = treeGraph(APPS, INSTALLS, { measure, hosts: "under" })
  const leaves = g.nodes.filter((n) => n.id.startsWith("leaf:"))

  it("draws a copy of a host under each application it runs", () => {
    const python = leaves.filter((n) => n.id.startsWith("leaf:python:"))
    expect(python.map((n) => n.data.name).sort()).toEqual([
      "db-dev01",
      "db-ipam",
      "tf-01",
    ])
    // A host with five applications appears five times.
    expect(leaves.filter((n) => n.data.name === "db-dev01")).toHaveLength(5)
    expect(g.nodes.some((n) => n.id.startsWith("host:"))).toBe(false)
  })

  it("shows the version installed on each copy", () => {
    const leaf = leaves.find((n) => n.id === "leaf:redis:device:db-ipam")!
    expect(leaf.data.input.lines.map((l) => l.text)).toEqual(["6.1"])
    const ref = leaf.data.ref
    expect(ref.kind === "host" && ref.app).toBe("redis")
    expect(ref.kind === "host" && ref.host.installs.map((i) => i.id)).toEqual([
      "d2-4",
    ])
  })

  it("links each copy to its application alone, right under it", () => {
    for (const leaf of leaves) {
      const lines = g.edges.filter((e) => e.target === leaf.id)
      expect(lines).toHaveLength(1)
      const src = g.nodes.find((n) => n.id === lines[0].source)!
      // Its application's copies sit side by side under it.
      const mine = leaves.filter((l) =>
        l.id.startsWith(`leaf:${src.id.slice(4)}:`)
      )
      const xs = mine.map((l) => l.position.x)
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2
      expect(Math.abs(mid - src.position.x)).toBeLessThanOrEqual(1)
    }
    expect(collisions(g)).toEqual([])
  })

  it("leaves the hosts out when off", () => {
    const off = treeGraph(APPS, INSTALLS, { measure, hosts: "off" })
    expect(off.nodes.every((n) => n.data.ref.kind === "application")).toBe(true)
  })
})

describe("focus on hover and selection", () => {
  const g = treeGraph(APPS, INSTALLS, { measure })

  it("brings an application forward with its host lines and hosts", () => {
    const f = focusSet(g, "app:python")!
    expect([...f.nodes].sort()).toEqual(
      [
        "app:python",
        "host:device:db-dev01",
        "host:device:db-ipam",
        "host:device:tf-01",
      ].sort()
    )
    expect([...f.edges].every((id) => id.startsWith("install:python:"))).toBe(
      true
    )
    expect(f.edges.size).toBe(3)
  })

  it("brings a host forward with its applications", () => {
    const f = focusSet(g, "host:device:tf-01")!
    expect([...f.nodes].sort()).toEqual(
      ["app:ansible", "app:python", "app:terraform", "host:device:tf-01"].sort()
    )
    expect(focusSet(g, null)).toBeNull()
    expect(focusSet(g, "nope")).toBeNull()
  })

  describe("down and up the hierarchy", () => {
    // Platform > (Web > Cache, Worker); only the leaves are installed.
    const platform = app("platform", "Platform")
    const under = (id: string, name: string, parent: Application) =>
      app(id, name, {
        parent: { id: parent.id, name: parent.name } as Application["parent"],
      })
    const web = under("web", "Web", platform)
    const cache = under("cache", "Cache", web)
    const worker = under("worker", "Worker", platform)
    const h = treeGraph(
      [platform, web, cache, worker],
      [install("i1", cache, "h1"), install("i2", worker, "h2")],
      { measure }
    )

    it("brings a parent forward with its subtree, host lines and hosts", () => {
      const f = focusSet(h, "app:platform")!
      expect([...f.nodes].sort()).toEqual(
        [
          "app:cache",
          "app:platform",
          "app:web",
          "app:worker",
          "host:device:h1",
          "host:device:h2",
        ].sort()
      )
      expect(f.edges.size).toBe(5)
      expect(f.trail.size).toBe(0)
    })

    it("brings a child's ancestors forward as a trail", () => {
      const f = focusSet(h, "app:web")!
      expect(f.nodes.has("app:worker")).toBe(false)
      expect(f.nodes.has("host:device:h2")).toBe(false)
      expect([...f.trail]).toEqual(["child:web"])
      const drawn = toFlow(h, null, null, null, "app:web")
      const up = drawn.edges.find((e) => e.id === "child:web")!
      expect(up.className).toBeUndefined()
      expect(up.style?.opacity).toBeUndefined()
    })

    it("brings a host forward with its applications' ancestors", () => {
      const f = focusSet(h, "host:device:h1")!
      expect([...f.nodes].sort()).toEqual(
        ["app:cache", "app:platform", "app:web", "host:device:h1"].sort()
      )
      expect([...f.trail].sort()).toEqual(["child:cache", "child:web"])
    })
  })

  it("fades everything else on the canvas", () => {
    const drawn = toFlow(g, null, null, null, "app:vault")
    const dimmed = (id: string) =>
      (drawn.nodes.find((n) => n.id === id)!.data as { dimmed?: boolean })
        .dimmed
    expect(dimmed("app:vault")).toBe(false)
    expect(dimmed("host:device:db-vault")).toBe(false)
    expect(dimmed("app:python")).toBe(true)
    const lit = drawn.edges.find(
      (e) => e.id === "install:vault:host:device:db-vault"
    )!
    expect(lit.className).toBe("topo-hot")
    expect(lit.style?.opacity).toBeUndefined()
    const other = drawn.edges.find(
      (e) => e.id === "install:python:host:device:tf-01"
    )!
    expect(other.style?.opacity).toBeLessThan(0.5)
    // No focus: nothing fades.
    const plain = toFlow(g, null, null, null, null)
    expect(
      plain.nodes.some((n) => (n.data as { dimmed?: boolean }).dimmed)
    ).toBe(false)
  })
})

// ── Flows ─────────────────────────────────────────────────────────────────

const APPL = {
  id: "danbyte",
  name: "Danbyte",
  slug: "danbyte",
  path: "Danbyte",
}

const ip = (label: string, host: string): FlowEnd => ({
  kind: "ip",
  id: `ip-${label}`,
  label,
  device: { id: `d-${host}`, name: host },
  vm: null,
})
const ANY: FlowEnd = {
  kind: "any",
  id: null,
  label: "Any",
  device: null,
  vm: null,
}
const NET: FlowEnd = {
  kind: "prefix",
  id: "p16",
  label: "10.0.0.0/16",
  device: null,
  vm: null,
}

function flow(
  id: string,
  source: FlowEnd,
  destination: FlowEnd,
  protocol: string,
  ports: string
): ApplicationFlow {
  return {
    id,
    numid: null,
    application: APPL,
    name: id,
    description: "",
    source,
    destination,
    protocol,
    protocol_display: protocol.toUpperCase(),
    ports,
    direction: "one-way",
    direction_display: "One way",
    status: null,
    service: null,
    tags: [],
  } as unknown as ApplicationFlow
}

// The Danbyte application's Diagram tab: kbh-srv1 out to Any, the /16,
// aalborg-core1, db-dc, db-ipam and kbh-srv2 - and on from db-ipam, so a
// line spans a column.
const SRV1 = ip("10.0.0.41", "kbh-srv1")
const FLOWS = [
  flow("snmp", SRV1, ANY, "udp", "161"),
  flow("icmp", SRV1, NET, "icmp", ""),
  flow("ssh", SRV1, ip("10.0.0.1", "aalborg-core1"), "tcp", "22"),
  flow("ldap", SRV1, ip("10.0.0.10", "db-dc"), "tcp", "389"),
  flow("https", SRV1, ip("10.0.0.42", "db-ipam"), "tcp", "443"),
  flow("vault", SRV1, ip("10.0.0.48", "kbh-srv2"), "tcp", "8200"),
  flow("dns", SRV1, ANY, "udp", "53"),
  flow(
    "sync",
    ip("10.0.0.42", "db-ipam"),
    ip("10.0.0.49", "kbh-srv3"),
    "tcp",
    "8443"
  ),
  flow("back", ip("10.0.0.49", "kbh-srv3"), SRV1, "tcp", "9100"),
  flow("ntp", ip("10.0.0.10", "db-dc"), NET, "udp", "123"),
  flow(
    "peer",
    ip("10.0.0.10", "db-dc"),
    ip("10.0.0.42", "db-ipam"),
    "tcp",
    "636"
  ),
]

describe("Flows lines", () => {
  const g = flowsGraph(FLOWS, { measure })

  it("crosses no card it does not join", () => {
    expect(g.edges.length).toBeGreaterThan(8)
    expect(collisions(g)).toEqual([])
  })

  it("keeps the protocol labels off the cards", () => {
    const boxes = g.nodes.map((n) => [n.id, boxOf(n)] as const)
    for (const e of g.edges) {
      const mid = e.data!.labels.mid ?? []
      if (!mid.length || e.data!.crowded) continue
      const route = plannedRoute(e)!
      const c = chipCentre(
        (u) => route.at(u),
        e.data!.midT ?? 0.5,
        e.data!.midOff ?? 0
      )
      const w = Math.max(...mid.map((m) => measure(m))) + 2 * LABEL.PAD_X
      const h = mid.length * LABEL.MID_LH + 3
      const chip = { x: c.x - w / 2, y: c.y - h / 2, w, h }
      for (const [id, r] of boxes) {
        const overlap =
          chip.x < r.x + r.w &&
          chip.x + chip.w > r.x &&
          chip.y < r.y + r.h &&
          chip.y + chip.h > r.y
        expect(overlap, `${e.id} label on ${id}`).toBe(false)
      }
    }
  })

  it("sends a busy end to the end of its column", () => {
    // Three sources all reach the /16, and one each reaches its own
    // address: the /16 would sit mid-stack by its sources' mean.
    const srcs = ["a", "b", "c"].map((h, i) => ip(`10.1.0.${i}`, `src-${h}`))
    const busy = flowsGraph(
      [
        ...srcs.map((s, i) => flow(`n${i}`, s, NET, "tcp", "443")),
        ...srcs.map((s, i) =>
          flow(`o${i}`, s, ip(`10.2.0.${i}`, `dst-${i}`), "tcp", "22")
        ),
      ],
      { measure }
    )
    const net = busy.nodes.find((n) => n.data.name === "10.0.0.0/16")!
    const column = busy.nodes.filter(
      (n) => Math.abs(n.position.x - net.position.x) < 1
    )
    expect(column).toHaveLength(4)
    const ys = column.map((n) => n.position.y)
    expect([Math.min(...ys), Math.max(...ys)]).toContain(net.position.y)
    expect(collisions(busy)).toEqual([])
  })

  it("leaves a fan-out through channels of its own", () => {
    const fan = g.edges.filter(
      (e) =>
        e.source === "danbyte:ip:ip-10.0.0.41" &&
        e.data!.plan![0].line === "bendy"
    )
    const xs = fan.map((e) => e.data!.plan![0].pts[1].x)
    expect(new Set(xs).size).toBe(xs.length)
  })

  it("routes round a card dragged into the way", () => {
    const ipam = g.nodes.find((n) => n.data.name === "db-ipam")!
    const srv1 = g.nodes.find((n) => n.data.name === "kbh-srv1")!
    const moved = withPositions(g, {
      [ipam.id]: [(srv1.position.x + ipam.position.x) / 2, srv1.position.y],
    })
    expect(collisions(moved)).toEqual([])
  })
})

describe("orthoPath", () => {
  it("goes round a card between two ends", () => {
    const wall: Rect = { x: 100, y: -50, w: 40, h: 100 }
    const pts = orthoPath(
      { x: 0, y: 0, dir: [1, 0] },
      { x: 300, y: 0, dir: [-1, 0] },
      [wall]
    )!
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts.at(-1)).toEqual({ x: 300, y: 0 })
    for (let i = 1; i < pts.length; i++) {
      // Orthogonal…
      const [p, q] = [pts[i - 1], pts[i]]
      expect(p.x === q.x || p.y === q.y).toBe(true)
      // …and clear of the wall.
      for (let k = 0; k <= 20; k++) {
        const s = {
          x: p.x + ((q.x - p.x) * k) / 20,
          y: p.y + ((q.y - p.y) * k) / 20,
        }
        expect(inside(s, wall)).toBe(false)
      }
    }
  })
})
