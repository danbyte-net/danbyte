import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import type { TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import {
  DEV,
  aliasIds,
  devId,
  fabricGraph,
  groupedGraph,
  miniMapGraph,
  miniOrigin,
  traceGraph,
} from "../__fixtures__/fabric-graph"
import { meshGraph } from "../__fixtures__/fanout-graph"
import { PANEL_IDS, panelDev, panelTrace } from "../__fixtures__/panel-trace"
import {
  boxOf as cardBox,
  drawn,
  throughCards,
} from "../__fixtures__/route-checks"
import { linkEnds } from "./anchors"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { NUB } from "./card-layout"
import { runOrder, traceMap } from "../trace-run"
import { leaves, linkRoute, planOf, routeThrough } from "./link-geometry"
import type { PortPlace } from "@/lib/diagram/geometry"
import type {
  DiagramCardData,
  DiagramEdgeData,
  DiagramMode,
  LineType,
  Rect,
} from "./types"

// Golden files for the Diagram pipeline on the build() parity fabric: every
// card's box, text and nubs, every link's anchors, and the path each cable
// draws - Simple and Detailed, for each line type. Deterministic: text is
// measured with Inter's own advance widths, never the DOM.

/** The fabric as `include=card` sends it: the default lines (monitoring
 * pill, IP, Loopback, Serial), with a loopback and a serial per device. */
const cardGraph: TopologyGraph = {
  ...fabricGraph,
  nodes: fabricGraph.nodes.map((n, i): TopoNode => {
    if (n.data.panel) return { ...n, data: { ...n.data, card: undefined } }
    const ip = n.data.primary_ip
    return {
      ...n,
      data: {
        ...n.data,
        card: {
          fields: ["monitor", "primary_ip", "loopback", "serial"],
          source: "default",
          values: {
            primary_ip: ip
              ? { id: `ip${i}`, address: ip, cidr: `${ip}/24` }
              : null,
            loopback: [
              {
                id: `lo${i}`,
                address: `10.255.0.${i + 1}`,
                cidr: `10.255.0.${i + 1}/32`,
              },
            ],
            serial: `FDO22${String(i).padStart(3, "0")}X`,
          },
        },
      },
    }
  }),
}

const r1 = (v: number) => {
  const r = Math.round(v * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

function boxOf(n: Node): Rect {
  return {
    x: n.position.x - n.width! / 2,
    y: n.position.y - n.height! / 2,
    w: n.width!,
    h: n.height!,
  }
}

function nodeLine(n: Node): string {
  const base = `${n.id}  ${n.type} @${r1(n.position.x)},${r1(n.position.y)} ${n.width}x${n.height}`
  if (n.type !== "card") return base
  const d = n.data as DiagramCardData
  const { box, nubs } = d.diagram
  const lines = box.lines.map((l) => `${l.key}=${JSON.stringify(l.text)}`)
  return [
    base,
    `  fill ${box.fill ?? "neutral"} ink ${box.ink ?? "theme"}${box.stacked ? " stacked" : ""}`,
    `  title ${JSON.stringify(box.title.text)} top ${box.title.top}`,
    ...(lines.length ? [`  lines ${lines.join(" ")}`] : []),
    ...(nubs.length
      ? [
          `  nubs ${nubs
            .map((u) => `${u.side}${r1(u.off)}${u.port ? `:${u.port}` : ""}`)
            .join(" ")}`,
        ]
      : []),
  ].join("\n")
}

function edgeLines(e: Edge, byId: Map<string, Node>): string {
  const d = e.data as DiagramEdgeData
  const head = `${e.id}  ${e.type} ${d.sem} ${d.line}${d.simple ? " simple" : ""}${
    d.labels.mid?.length ? ` mid ${JSON.stringify(d.labels.mid)}` : ""
  }`
  const style = `  style ${JSON.stringify(e.style)}`
  if (e.type !== "link") return [head, style].join("\n")
  const s = boxOf(byId.get(e.source)!)
  const t = boxOf(byId.get(e.target)!)
  const anchors = (list: DiagramEdgeData["a"]) =>
    list
      .map((a) =>
        a.k === "side"
          ? `${a.side}${r1(a.off)}${a.port ? `:${a.port}` : ""}`
          : a.k === "junction"
            ? `junction(${a.dir.join(",")})`
            : a.port
      )
      .join(" ")
  const plan = planOf(d, s, t)
  const place = (p: PortPlace | null | undefined) =>
    p === null ? "off" : p ? `${r1(p.x)},${r1(p.y)}@${r1(p.rotate)}` : ""
  const routes = plan
    ? plan.map((p) =>
        [
          `  path ${routeThrough(p.line ?? d.line, p.pts, leaves(p.pts)).d}${
            p.line ? ` (${p.line})` : ""
          }`,
          ...(p.a !== undefined || p.b !== undefined
            ? [`    ports a ${place(p.a)} b ${place(p.b)}`]
            : []),
        ].join("\n")
      )
    : linkEnds(d, s, t).map(
        ([a, b]) => `  path ${linkRoute(d.line, a, b).d} (unplanned)`
      )
  return [
    head,
    style,
    ...(d.a.length ? [`  a ${anchors(d.a)}`, `  b ${anchors(d.b)}`] : []),
    ...(d.midT !== undefined
      ? [`  mid at ${d.midT}${d.crowded ? " crowded" : ""}`]
      : []),
    ...routes,
  ].join("\n")
}

function golden(graph: TopologyGraph, opts: DiagramOptions): string {
  const out = buildDiagram(graph, { ...opts, measure: approxMeasure })
  const byId = new Map(out.nodes.map((n) => [n.id, n]))
  const { measure: _m, ...shown } = opts
  return aliasIds(
    [
      `# buildDiagram(graph, ${JSON.stringify(shown)})`,
      "",
      `nodes ${out.nodes.length}`,
      ...out.nodes.map(nodeLine),
      "",
      `edges ${out.edges.length}`,
      ...out.edges.map((e) => edgeLines(e, byId)),
      "",
    ].join("\n")
  )
}

async function expectGolden(
  name: string,
  graph: TopologyGraph,
  o: DiagramOptions,
  alias: (text: string) => string = (t) => t
) {
  const first = alias(golden(graph, o))
  // The same input builds the same diagram twice.
  expect(alias(golden(graph, o))).toBe(first)
  await expect(first).toMatchFileSnapshot(
    `./__snapshots__/build-diagram/${name}.txt`
  )
}

/** The panel trace's UUIDs as readable names. */
const panelAlias = (text: string) =>
  Object.entries(PANEL_IDS).reduce(
    (t, [id, name]) => t.replaceAll(id, name),
    text
  )

const MODES: DiagramMode[] = ["simple", "detailed"]
const LINES: LineType[] = ["straight", "elbow", "bendy"]

describe("buildDiagram golden", () => {
  for (const mode of MODES)
    for (const line of LINES)
      it(`fabric · ${mode} · ${line}`, async () => {
        await expectGolden(`fabric-${mode}-${line}`, cardGraph, {
          mode,
          line,
          colorMode: "cable",
          direction: "TB",
        })
      })

  // An N:M breakout beside a 1:N one: its junctions at the thirds of the
  // gap, and no route (bendy legs included) through a card.
  for (const [mode, line] of [
    ["detailed", "elbow"],
    ["detailed", "bendy"],
    ["simple", "elbow"],
  ] as const)
    it(`N:M breakout · ${mode} · ${line}`, async () => {
      const o: DiagramOptions = { mode, line, colorMode: "cable" }
      await expectGolden(`mesh-${mode}-${line}`, meshGraph, o)
      const b = buildDiagram(meshGraph, { ...o, measure: approxMeasure })
      const cards = new Map(
        b.nodes.filter((n) => n.type === "card").map((n) => [n.id, cardBox(n)])
      )
      expect(
        throughCards(drawn(b.nodes, b.edges, approxMeasure), cards)
      ).toEqual([])
    })

  it("grouped by site draws the Simple picture", async () => {
    await expectGolden("grouped", groupedGraph, {
      mode: "detailed",
      line: "straight",
      colorMode: "cable",
    })
  })

  // The trace maps and a device's map (embedded-map.tsx): Detailed with
  // Elbow lines. A trace crosses two patch panels, each a card with a nub
  // on the front and the rear port its run uses, and draws its run in the
  // accent colour; the device map carries an LLDP ghost.
  for (const direction of ["LR", "TB"] as const)
    it(`trace map · ${direction}`, async () => {
      await expectGolden(`trace-${direction.toLowerCase()}`, traceGraph, {
        mode: "detailed",
        line: "elbow",
        colorMode: "cable",
        direction,
      })
    })

  // A cable trace through one panel as the API sends it: both cables of
  // the run point into the panel. Ranked along the run, the panel sits
  // between the server and the switch, its front port facing one and its
  // rear port the other, and its cable off the run is left out.
  for (const direction of ["LR", "TB"] as const)
    it(`trace map through a panel · ${direction}`, async () => {
      await expectGolden(
        `trace-panel-${direction.toLowerCase()}`,
        traceMap(panelTrace)!,
        {
          mode: "detailed",
          line: "elbow",
          colorMode: "cable",
          direction,
          run: runOrder(panelTrace),
        },
        panelAlias
      )
    })

  it("device map", async () => {
    await expectGolden("mini-focus", miniMapGraph, {
      mode: "detailed",
      line: "elbow",
      colorMode: "cable",
      focusNodeId: miniOrigin,
    })
  })
})

describe("the trace maps and a device's map", () => {
  const opts: DiagramOptions = {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
  }

  it("outline the device the map is about", () => {
    const b = buildDiagram(miniMapGraph, { ...opts, focusNodeId: miniOrigin })
    expect(b.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([
      miniOrigin,
    ])
  })

  it("draw the traced run thick in the accent colour", () => {
    const b = buildDiagram(traceGraph, opts)
    const cables = b.edges.filter(
      (e) => (e.data as DiagramEdgeData).sem === "cable"
    )
    const run = cables.filter((e) => (e.data as DiagramEdgeData).raw?.marked)
    expect(run.length).toBeGreaterThan(1)
    for (const e of run) {
      expect(e.style).toMatchObject({
        stroke: "var(--map-accent)",
        strokeWidth: 2.5,
      })
      expect(e.animated).toBe(true)
    }
    // The spare cable beside the run keeps its own look.
    const spare = cables.filter((e) => !(e.data as DiagramEdgeData).raw?.marked)
    expect(spare.length).toBeGreaterThan(0)
    for (const e of spare) expect(e.style?.stroke).not.toBe("var(--map-accent)")
  })

  it("put a patch panel between the ends of its run, front one way, rear the other", () => {
    for (const direction of ["LR", "TB"] as const) {
      const b = buildDiagram(traceMap(panelTrace)!, {
        ...opts,
        direction,
        run: runOrder(panelTrace),
      })
      const at = (id: string) => b.nodes.find((n) => n.id === id)!.position
      const axis = direction === "LR" ? "x" : "y"
      const [srv, pp, dist] = [panelDev.srv, panelDev.pp, panelDev.dist].map(
        (id) => at(id)[axis]
      )
      expect(srv).toBeLessThan(pp)
      expect(pp).toBeLessThan(dist)
      const panel = b.nodes.find((n) => n.id === panelDev.pp)!
      const nubs = (panel.data as DiagramCardData).diagram.nubs
      const [back, ahead] = direction === "LR" ? ["L", "R"] : ["T", "B"]
      expect(nubs.map((u) => `${u.side}:${u.port}`).sort()).toEqual(
        [`${back}:front1`, `${ahead}:rear1`].sort()
      )
    }
  })

  it("give a patch panel a nub on each front and rear port of the run", () => {
    const b = buildDiagram(traceGraph, opts)
    const panel = b.nodes.find((n) => n.id === devId("ppa"))!
    const d = panel.data as DiagramCardData
    expect(d.panel).toBe(true)
    expect(d.diagram.nubs.map((u) => u.port).sort()).toEqual(["1", "R1"])
  })
})

describe("buildDiagram", () => {
  const build = (o: Partial<DiagramOptions> = {}) =>
    buildDiagram(cardGraph, {
      mode: "detailed",
      line: "straight",
      colorMode: "cable",
      measure: approxMeasure,
      ...o,
    })

  it("places every node by its centre, sized to its box", () => {
    const { nodes } = build()
    for (const n of nodes) {
      expect(n.origin).toEqual([0.5, 0.5])
      if (n.type !== "card") continue
      const { box } = (n.data as DiagramCardData).diagram
      expect([n.width, n.height]).toEqual([box.w, box.h])
    }
  })

  it("fills a card with its role colour and a readable ink", () => {
    const { nodes } = build()
    const spine = nodes.find((n) => n.id === devId("spine1"))!
    const { box } = (spine.data as DiagramCardData).diagram
    expect(box.fill).toBe("#6366f1")
    expect(box.ink).toBe("#fff")
    expect(box.title.text).toBe("spine-01")
    expect(box.lines.map((l) => l.key)).toEqual([
      "primary_ip",
      "loopback",
      "serial",
    ])
  })

  it("gives each member of an aggregate its own nub in Detailed", () => {
    const { edges, nodes } = build()
    const lag = edges.find(
      (e) => (e.data as DiagramEdgeData).sem === "lagbundle"
    )!
    const d = lag.data as DiagramEdgeData
    expect(d.a).toHaveLength(2)
    expect(d.b).toHaveLength(2)
    expect(d.labels.mid).toEqual(["Po10 ⇄ Po10 · 2x"])
    const leaf1 = nodes.find((n) => n.id === devId("leaf1"))!
    const ports = (leaf1.data as DiagramCardData).diagram.nubs.map(
      (u) => u.port
    )
    expect(ports).toEqual(
      expect.arrayContaining(["Ethernet1/53", "Ethernet1/54"])
    )
  })

  it("folds a pair's cables into one link in Simple", () => {
    const { edges } = build({ mode: "simple" })
    const pair = edges.filter((e) => {
      const ends = [e.source, e.target]
      return ends.includes(devId("spine1")) && ends.includes(devId("leaf1"))
    })
    expect(pair).toHaveLength(1)
    const d = pair[0].data as DiagramEdgeData
    expect(d.simple).toBe(true)
    expect(d.labels.mid).toEqual(["2x"])
  })

  it("keeps LLDP ghosts straight and BGP on the overlay line", () => {
    const { edges } = build({ line: "bendy" })
    const ghost = edges.find((e) => e.id.startsWith("ghost:"))!
    expect((ghost.data as DiagramEdgeData).line).toBe("straight")
    expect((ghost.data as DiagramEdgeData).simple).toBe(true)
    expect(ghost.style?.strokeDasharray).toBe("6 4")
    const bgp = edges.filter((e) => e.id.startsWith("bgp:"))
    expect(bgp.map((e) => e.type)).toEqual(["overlay", "overlay"])
  })

  it("applies a per-pair line override", () => {
    const key = [DEV.spine1, DEV.leaf1].sort().join("|")
    const { edges } = build({ links: { [key]: { line: "elbow" } } })
    const lines = edges
      .filter((e) => (e.data as DiagramEdgeData).pairKey === key)
      .map((e) => (e.data as DiagramEdgeData).line)
    expect(lines.length).toBeGreaterThan(0)
    expect(new Set(lines)).toEqual(new Set(["elbow"]))
  })

  it("keeps a saved centre in both modes", () => {
    const at: [number, number] = [1234, 567]
    const positions = { [devId("spine1")]: at }
    for (const mode of MODES) {
      const { nodes } = build({ mode, positions })
      const n = nodes.find((x) => x.id === devId("spine1"))!
      expect([n.position.x, n.position.y]).toEqual(at)
    }
  })

  it("re-anchors after a drag without a new layout", () => {
    const built = build()
    const moved = built.nodes.map((n) =>
      n.id === devId("srv1")
        ? { ...n, position: { x: n.position.x - 2000, y: n.position.y } }
        : n
    )
    const re = relinkDiagram(built.model, moved)
    const link = re.edges.find(
      (e) => e.target === devId("srv1") || e.source === devId("srv1")
    )!
    const d = link.data as DiagramEdgeData
    const end = sideAnchor(d, link.source === devId("srv1") ? "a" : "b")
    // The server now sits far to the left: its cables leave its right side.
    expect(end.side).toBe("R")
    // Cards that did not change keep their data object.
    expect(re.cards.has(devId("oob1"))).toBe(false)
  })

  it("dims search misses", () => {
    const { nodes } = build({ matched: new Set([devId("leaf1")]) })
    const dim = nodes.filter((n) => (n.data as { dimmed?: boolean }).dimmed)
    expect(dim).toHaveLength(nodes.length - 1)
  })

  it("starts Detailed lines at the nub tip", () => {
    const { nodes, edges } = build()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const cable = edges.find(
      (x) => (x.data as DiagramEdgeData).sem === "cable"
    )!
    const d = cable.data as DiagramEdgeData
    const s = boxOf(byId.get(cable.source)!)
    const [[a]] = linkEnds(d, s, boxOf(byId.get(cable.target)!))
    const inside =
      a.x > s.x - NUB.OUT + 0.01 &&
      a.x < s.x + s.w + NUB.OUT - 0.01 &&
      a.y > s.y - NUB.OUT + 0.01 &&
      a.y < s.y + s.h + NUB.OUT - 0.01
    expect(inside).toBe(false)
  })
})

function sideAnchor(d: DiagramEdgeData, end: "a" | "b") {
  const a = d[end][0]
  if (a.k !== "side") throw new Error("side anchor expected")
  return a
}
