import dagre from "@dagrejs/dagre"
import type { Edge, EdgeMarker, Node } from "@xyflow/react"

import type {
  Application,
  ApplicationFlow,
  FlowEnd,
  InstalledSoftware,
  StatusMini,
} from "@/lib/api"
import { buildFlowDocument } from "@/lib/diagram/flow-document"
import type { Measure } from "@/lib/diagram/measure"
import { endHost, endKey, flowServiceLabel } from "@/lib/flows"
import { cssColor } from "@/lib/utils"
import { BAND } from "@/components/topology/diagram/bands"
import { cardLayout } from "@/components/topology/diagram/card-layout"
import type {
  CardBox,
  CardLayoutInput,
} from "@/components/topology/diagram/card-layout"
import { fitBox } from "@/components/topology/diagram/to-document"
import type {
  DiagramCardData,
  DiagramEdgeData,
  LineType,
} from "@/components/topology/diagram/types"

// The Application map (#163) as React Flow nodes and edges, drawn by the
// topology Diagram's own card and link (CardNode, LinkEdge) and exported by
// the same document writers. Two views:
//
// - Tree: the application hierarchy (`parent`) as layered rows - one row
//   band per depth, a card per application with its install and flow
//   counts, and, with Hosts on, the devices and VMs it is installed on as
//   compact cards in a last row. Laid out top to bottom by dagre.
// - Flows: one card per flow end (an address titled with its device or VM,
//   a range, a prefix, "Any") in a row band per application, laid out by
//   the flow diagram's own rank layout (flow-document.ts), and one line per
//   pair of cards carrying their flows' protocols and ports, arrowed by
//   direction and coloured by status.
//
// Pure: no React, no fetching. Cards are placed by their centre, as the
// Diagram's are.

export type AppMapView = "tree" | "flows"

export const APP_MAP_VIEWS: readonly AppMapView[] = ["tree", "flows"]

/** A device or VM with installs, as a tree leaf. */
export interface AppHost {
  kind: "device" | "vm"
  id: string
  name: string
  /** The installs on it of the applications shown. */
  installs: InstalledSoftware[]
}

/** What a card stands for. */
export type AppMapRef =
  | { kind: "application"; app: Application }
  | { kind: "host"; host: AppHost }
  | {
      kind: "end"
      end: FlowEnd
      application: ApplicationFlow["application"]
      flows: ApplicationFlow[]
    }

export type AppCardData = DiagramCardData & {
  ref: AppMapRef
  /** What the card was laid out from: the export lays it out the same. */
  input: CardLayoutInput
}

/** How a line ends: arrowheads at the target, the source, both or none. */
export type AppArrow = "end" | "start" | "both" | "none"

export type AppEdgeData = DiagramEdgeData & {
  kind: "child" | "install" | "flow"
  /** Flow lines: the flows between the two cards, both ways. */
  flows?: ApplicationFlow[]
  arrow: AppArrow
  /** The line's paint, for the export: the stroke (a colour or a CSS
   * variable), width, dash and whether it is faded (retired). */
  paint: { stroke?: string; width: number; dash?: string; faded?: boolean }
}

export type AppCardNode = Node<AppCardData, "card">
export type AppEdge = Edge<AppEdgeData, "link">

/** A row band behind the cards. */
export interface AppBand {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  /** Flows view: the application the row holds. */
  application?: ApplicationFlow["application"]
}

export interface AppMapGraph {
  nodes: AppCardNode[]
  edges: AppEdge[]
  bands: AppBand[]
}

/** Spacing of the Tree's rows and cards. */
export const TREE = {
  /** Between two cards in a row. */
  NODE_GAP: 32,
  /** Inside a row band: under its title strip, and under its cards. */
  PAD_TOP: 12,
  PAD_BOTTOM: 20,
  PAD_X: 40,
  /** Between two row bands. */
  BAND_GAP: 40,
} as const

const NEUTRAL_LINE = "var(--muted-foreground)"

const cmp = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** An application card's colour: its first coloured tag, else none (the
 * neutral card) - applications have no colour of their own. */
export function applicationColor(
  app: Pick<Application, "tags">
): string | null {
  const tag = app.tags.find((t) => !!cssColor(t.color))
  return tag ? (cssColor(tag.color) ?? null) : null
}

/** An application card's text: the name, and its installs and flows. */
export function applicationCard(app: Application): CardLayoutInput {
  return {
    name: app.name,
    color: applicationColor(app),
    lines: [
      {
        key: "counts",
        text: `${plural(app.install_count, "install", "installs")} · ${plural(
          app.flow_count,
          "flow",
          "flows"
        )}`,
      },
    ],
  }
}

export const hostKey = (kind: AppHost["kind"], id: string) =>
  `host:${kind}:${id}`

/** The tree row names, top to bottom: three levels read domain, process
 * and application, as the catalog's tree is described; one level is the
 * applications; any other depth is numbered. */
export function levelLabels(levels: number): string[] {
  if (levels === 1) return ["Applications"]
  if (levels === 3) return ["Domains", "Processes", "Applications"]
  return Array.from({ length: levels }, (_, i) => `Level ${i + 1}`)
}

function cardNode(
  id: string,
  ref: AppMapRef,
  input: CardLayoutInput,
  box: CardBox,
  extra: Partial<DiagramCardData> = {}
): AppCardNode {
  return {
    id,
    type: "card",
    position: { x: 0, y: 0 },
    origin: [0.5, 0.5],
    width: box.w,
    height: box.h,
    data: {
      name: input.name,
      ...extra,
      ref,
      input,
      diagram: { box, nubs: [], mode: "simple" },
    },
  }
}

function marker(arrow: AppArrow, color: string) {
  const m: EdgeMarker = {
    // MarkerType.ArrowClosed, spelled out: this module stays free of
    // React Flow's runtime.
    type: "arrowclosed",
    color,
    width: 16,
    height: 16,
  }
  return {
    ...(arrow === "end" || arrow === "both" ? { markerEnd: m } : {}),
    ...(arrow === "start" || arrow === "both" ? { markerStart: m } : {}),
  }
}

function linkEdge(
  id: string,
  source: string,
  target: string,
  line: LineType,
  data: Omit<
    AppEdgeData,
    "sem" | "pairKey" | "line" | "a" | "b" | "labels" | "simple"
  > & { mid?: string[] }
): AppEdge {
  const { mid, ...rest } = data
  const stroke = rest.paint.stroke ?? NEUTRAL_LINE
  return {
    id,
    source,
    target,
    type: "link",
    data: {
      ...rest,
      sem: "cable",
      pairKey: source < target ? `${source}|${target}` : `${target}|${source}`,
      line,
      a: [],
      b: [],
      // Side midpoints, recomputed from the live boxes while a card is
      // dragged: no port names on these lines.
      simple: true,
      labels: { ...(mid?.length ? { mid } : {}), noPorts: true },
    },
    style: {
      stroke,
      strokeWidth: rest.paint.width,
      ...(rest.paint.dash ? { strokeDasharray: rest.paint.dash } : {}),
      ...(rest.paint.faded ? { opacity: 0.45 } : {}),
    },
    ...(rest.paint.faded ? { labelStyle: { opacity: 0.6 } } : {}),
    ...marker(rest.arrow, stroke),
  }
}

// ── Tree ──────────────────────────────────────────────────────────────────

export interface TreeOptions {
  /** Applications picked: those, their ancestors and their descendants.
   * Empty = every application. */
  applications?: readonly string[]
  /** Only the applications installed on this host (`device:<id>` or
   * `vm:<id>`), with their ancestors. */
  host?: string
  /** Draw the hosts under their applications. */
  hosts?: boolean
  measure?: Measure
}

/** The applications the Tree shows, with their depth in it. */
function treeScope(
  apps: readonly Application[],
  installs: readonly InstalledSoftware[],
  opts: TreeOptions
): Map<string, Application> {
  const byId = new Map(apps.map((a) => [a.id, a]))
  const kids = new Map<string, Application[]>()
  for (const a of apps)
    if (a.parent && byId.has(a.parent.id))
      (
        kids.get(a.parent.id) ?? kids.set(a.parent.id, []).get(a.parent.id)!
      ).push(a)
  let picked: Set<string> | null = null
  if (opts.applications?.length) {
    picked = new Set()
    const down = (id: string) => {
      if (picked!.has(id)) return
      picked!.add(id)
      for (const k of kids.get(id) ?? []) down(k.id)
    }
    for (const id of opts.applications) if (byId.has(id)) down(id)
  }
  if (opts.host) {
    const on = new Set(
      installs
        .filter((i) => hostOf(i) === opts.host)
        .map((i) => i.application.id)
    )
    picked = new Set([...(picked ?? byId.keys())].filter((id) => on.has(id)))
  }
  const shown = new Map<string, Application>()
  for (const id of picked ?? byId.keys()) {
    // With its ancestors, so the tree stays a tree.
    let a = byId.get(id)
    const seen = new Set<string>()
    while (a && !seen.has(a.id)) {
      seen.add(a.id)
      shown.set(a.id, a)
      a = a.parent ? byId.get(a.parent.id) : undefined
    }
  }
  return shown
}

/** An install's host key: `device:<id>` or `vm:<id>`. */
export function hostOf(i: InstalledSoftware): string | null {
  return i.device
    ? `device:${i.device.id}`
    : i.virtual_machine
      ? `vm:${i.virtual_machine.id}`
      : null
}

export function treeGraph(
  apps: readonly Application[],
  installs: readonly InstalledSoftware[],
  opts: TreeOptions = {}
): AppMapGraph {
  const shown = treeScope(apps, installs, opts)
  if (!shown.size) return { nodes: [], edges: [], bands: [] }

  // Depth within what is shown: a parent outside the tenant's list (or a
  // cycle the API refused) starts a new root.
  const depth = new Map<string, number>()
  const depthOf = (a: Application, guard = 0): number => {
    const known = depth.get(a.id)
    if (known !== undefined) return known
    const p = a.parent ? shown.get(a.parent.id) : undefined
    const d = p && guard < 64 ? depthOf(p, guard + 1) + 1 : 0
    depth.set(a.id, d)
    return d
  }
  const ordered = [...shown.values()].sort(
    (a, b) => cmp(a.path || a.name, b.path || b.name) || cmp(a.id, b.id)
  )
  for (const a of ordered) depthOf(a)
  const appLevels = Math.max(...depth.values()) + 1

  const nodes: AppCardNode[] = []
  const edges: AppEdge[] = []
  const tier = new Map<string, number>()
  for (const a of ordered) {
    const input = applicationCard(a)
    const box = cardLayout(input, null, opts.measure)
    const id = `app:${a.id}`
    nodes.push(cardNode(id, { kind: "application", app: a }, input, box))
    tier.set(id, depth.get(a.id)!)
    if (a.parent && shown.has(a.parent.id))
      edges.push(
        linkEdge(`child:${a.id}`, `app:${a.parent.id}`, id, "elbow", {
          kind: "child",
          arrow: "none",
          paint: { width: 1.5 },
        })
      )
  }

  let hostTier = -1
  if (opts.hosts !== false) {
    const hosts = new Map<string, AppHost>()
    for (const i of installs) {
      if (!shown.has(i.application.id)) continue
      const key = hostOf(i)
      const ref = i.device ?? i.virtual_machine
      if (!key || !ref) continue
      let h = hosts.get(key)
      if (!h) {
        h = {
          kind: i.device ? "device" : "vm",
          id: ref.id,
          name: ref.name,
          installs: [],
        }
        hosts.set(key, h)
      }
      h.installs.push(i)
    }
    if (hosts.size) hostTier = appLevels
    const sorted = [...hosts.values()].sort(
      (a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)
    )
    for (const h of sorted) {
      const input: CardLayoutInput = { name: h.name, color: null, lines: [] }
      const box = cardLayout(input, null, opts.measure)
      const id = hostKey(h.kind, h.id)
      // A VM is dashed, as on the topology's Logical tab.
      nodes.push(
        cardNode(id, { kind: "host", host: h }, input, box, {
          ...(h.kind === "vm" ? { panel: true } : {}),
        })
      )
      tier.set(id, hostTier)
      const appIds = [
        ...new Set(h.installs.map((i) => i.application.id)),
      ].sort()
      for (const appId of appIds)
        edges.push(
          linkEdge(`install:${appId}:${id}`, `app:${appId}`, id, "bendy", {
            kind: "install",
            arrow: "none",
            paint: { width: 1, dash: "4 3" },
          })
        )
    }
  }

  // dagre orders each row to keep lines short and uncrossed; the rows
  // themselves are the tiers, so every card of a depth shares its band.
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "TB", nodesep: TREE.NODE_GAP, ranksep: 48 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height })
  for (const e of edges)
    g.setEdge(e.source, e.target, {
      minlen: Math.max(1, tier.get(e.target)! - tier.get(e.source)!),
    })
  dagre.layout(g)

  const levels = hostTier >= 0 ? hostTier + 1 : appLevels
  const heights = Array.from({ length: levels }, () => 0)
  for (const n of nodes) {
    const t = tier.get(n.id)!
    heights[t] = Math.max(heights[t], n.height ?? 0)
  }
  // Each row's top, under its band's title strip.
  const tops: number[] = []
  let y = BAND.TITLE + TREE.PAD_TOP
  for (let t = 0; t < levels; t++) {
    tops.push(y)
    y +=
      heights[t] + TREE.PAD_BOTTOM + TREE.BAND_GAP + BAND.TITLE + TREE.PAD_TOP
  }
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number }
    const t = tier.get(n.id)!
    n.position = { x: Math.round(p.x), y: tops[t] + heights[t] / 2 }
  }

  let x0 = Infinity
  let x1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.position.x - (n.width ?? 0) / 2)
    x1 = Math.max(x1, n.position.x + (n.width ?? 0) / 2)
  }
  const labels = levelLabels(appLevels)
  const bands: AppBand[] = []
  for (let t = 0; t < levels; t++) {
    if (!heights[t]) continue
    bands.push({
      id: t === hostTier ? "level:hosts" : `level:${t}`,
      label: t === hostTier ? "Hosts" : labels[t],
      x: x0 - TREE.PAD_X,
      y: tops[t] - BAND.TITLE - TREE.PAD_TOP,
      w: x1 - x0 + 2 * TREE.PAD_X,
      h: BAND.TITLE + TREE.PAD_TOP + heights[t] + TREE.PAD_BOTTOM,
    })
  }
  return { nodes, edges, bands }
}

// ── Flows ─────────────────────────────────────────────────────────────────

export interface FlowsOptions {
  measure?: Measure
}

/** A status's behaviour key, for the planned and retired looks. */
const statusKey = (s: StatusMini | null) =>
  (s?.slug || s?.name || "").toLowerCase()

/** The paint one card pair's flows share: their status's colour (a mix
 * stays neutral), dashed when every one is planned, faded when every one
 * is retired. */
export function flowPaint(
  flows: readonly ApplicationFlow[]
): AppEdgeData["paint"] {
  const ids = new Set(flows.map((f) => f.status?.id ?? ""))
  const one = ids.size === 1 ? flows[0].status : null
  const keys = new Set(flows.map((f) => statusKey(f.status)))
  const only = keys.size === 1 ? [...keys][0] : ""
  return {
    ...(one ? { stroke: cssColor(one.color) } : {}),
    width: flows.length > 1 ? 2 : 1.5,
    ...(only === "planned" ? { dash: "6 4" } : {}),
    ...(only === "retired" ? { faded: true } : {}),
  }
}

/** Where a pair's arrowheads go: the way its flows run, from `a` to `b`. */
export function flowArrow(
  flows: readonly ApplicationFlow[],
  a: string,
  keyOf: (f: ApplicationFlow, side: "source" | "destination") => string
): AppArrow {
  let fwd = false
  let back = false
  for (const f of flows) {
    if (f.direction === "both") return "both"
    if (keyOf(f, "source") === a) fwd = true
    else back = true
  }
  return fwd && back ? "both" : fwd ? "end" : back ? "start" : "none"
}

/** The middle label: each distinct protocol and ports once, the rest
 * counted. */
export function flowLabels(flows: readonly ApplicationFlow[]): string[] {
  const seen = [...new Set(flows.map(flowServiceLabel))]
  return seen.length > 3 ? [...seen.slice(0, 2), `+${seen.length - 2}`] : seen
}

export function flowsGraph(
  flows: readonly ApplicationFlow[],
  opts: FlowsOptions = {}
): AppMapGraph {
  if (!flows.length) return { nodes: [], edges: [], bands: [] }
  // The flow diagram's own layout: ranked columns, a row per application.
  const doc = buildFlowDocument(flows, {
    title: "",
    generatedAt: "",
    measure: opts.measure,
  })
  const keyOf = (f: ApplicationFlow, side: "source" | "destination") =>
    `${f.application.id}:${endKey(f[side], side)}`
  const ends = new Map<
    string,
    {
      end: FlowEnd
      app: ApplicationFlow["application"]
      flows: ApplicationFlow[]
    }
  >()
  for (const f of flows)
    for (const side of ["source", "destination"] as const) {
      const k = keyOf(f, side)
      const e = ends.get(k) ?? { end: f[side], app: f.application, flows: [] }
      if (!e.flows.includes(f)) e.flows.push(f)
      ends.set(k, e)
    }

  const nodes: AppCardNode[] = []
  for (const d of doc.nodes) {
    const e = ends.get(d.id)
    if (!e) continue
    const input: CardLayoutInput = {
      name: d.title,
      color: null,
      lines: d.lines.map((text, i) => ({ key: `l${i}`, text })),
    }
    // The column's width, so a column's cards line up.
    const box = fitBox(input, { w: d.w, h: d.h }, opts.measure)
    const n = cardNode(
      d.id,
      { kind: "end", end: e.end, application: e.app, flows: e.flows },
      input,
      box,
      // A VM's address is dashed, as its card is in the Tree.
      e.end.vm && !e.end.device ? { panel: true } : {}
    )
    n.position = { x: d.x + d.w / 2, y: d.y + box.h / 2 }
    nodes.push(n)
  }

  const pairs = new Map<
    string,
    { a: string; b: string; flows: ApplicationFlow[] }
  >()
  for (const f of flows) {
    const s = keyOf(f, "source")
    const t = keyOf(f, "destination")
    // A flow from an address to itself has no line to draw.
    if (s === t) continue
    const k = s < t ? `${s}|${t}` : `${t}|${s}`
    const p = pairs.get(k) ?? { a: s, b: t, flows: [] }
    p.flows.push(f)
    pairs.set(k, p)
  }
  const edges: AppEdge[] = []
  for (const [k, p] of pairs) {
    const sorted = [...p.flows].sort(
      (x, y) => cmp(x.name, y.name) || cmp(x.id, y.id)
    )
    edges.push(
      linkEdge(`flows:${k}`, p.a, p.b, "bendy", {
        kind: "flow",
        flows: sorted,
        arrow: flowArrow(sorted, p.a, keyOf),
        paint: flowPaint(sorted),
        mid: flowLabels(sorted),
      })
    )
  }

  const bands: AppBand[] = doc.bands.map((b) => {
    const app = flows.find(
      (f) => `app:${f.application.id}` === b.id
    )!.application
    return {
      id: b.id,
      label: b.label,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      application: app,
    }
  })
  return { nodes, edges, bands }
}

// ── Shared ────────────────────────────────────────────────────────────────

/** Cards moved by hand (centres, by id) put where they were left. */
export function withPositions(
  graph: AppMapGraph,
  positions: Readonly<Record<string, readonly [number, number]>> | undefined
): AppMapGraph {
  if (!positions || !Object.keys(positions).length) return graph
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (!Object.hasOwn(positions, n.id)) return n
      const [x, y] = positions[n.id]
      return { ...n, position: { x, y } }
    }),
  }
}

/** The words a card is found by: its name and lines, and what it stands
 * for. */
export function cardText(d: AppCardData): string {
  const ref = d.ref
  const extra =
    ref.kind === "application"
      ? [ref.app.path, ref.app.description]
      : ref.kind === "host"
        ? ref.host.installs.map((i) => i.application.name)
        : [ref.end.label, endHost(ref.end)?.name ?? "", ref.application.name]
  return [d.name, ...d.input.lines.map((l) => l.text), ...extra]
    .join(" ")
    .toLowerCase()
}

/** The ids of the cards a search matches; null = no search. */
export function matchCards(
  nodes: readonly AppCardNode[],
  query: string
): Set<string> | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return new Set(
    nodes
      .filter((n) => {
        const text = cardText(n.data)
        return words.every((w) => text.includes(w))
      })
      .map((n) => n.id)
  )
}

/** The map without the cards switched off, and their lines. */
export function withoutHidden(
  graph: AppMapGraph,
  hidden: ReadonlySet<string>
): AppMapGraph {
  if (!hidden.size) return graph
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !hidden.has(n.id)),
    edges: graph.edges.filter(
      (e) => !hidden.has(e.source) && !hidden.has(e.target)
    ),
  }
}

/** Moved cards in a URL: `id~x~y`, comma-separated. */
export function encodePositions(
  positions: Readonly<Record<string, readonly [number, number]>>
): string {
  return Object.entries(positions)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, [x, y]]) => `${id}~${Math.round(x)}~${Math.round(y)}`)
    .join(",")
}

/** …and back; a part that does not read is skipped. */
export function decodePositions(raw: string): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {}
  for (const part of raw.split(",")) {
    const [id, x, y] = part.split("~")
    const nx = Number(x)
    const ny = Number(y)
    if (id && x && y && Number.isFinite(nx) && Number.isFinite(ny))
      out[id] = [nx, ny]
  }
  return out
}
