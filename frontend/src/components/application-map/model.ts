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

import { routeGraph } from "./routing"

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

/** The Tree's hosts: none, one row of them, or a small copy of each under
 * every application it runs. */
export type HostsMode = "off" | "row" | "under"

export const HOSTS_MODES: readonly HostsMode[] = ["off", "row", "under"]

/** A Hosts setting: false or `off` none, `under`, else a row. */
export function hostsMode(v: boolean | HostsMode | undefined): HostsMode {
  if (v === false || v === "off") return "off"
  return v === "under" ? "under" : "row"
}

/** A device or VM with installs, as a tree leaf. */
export interface AppHost {
  kind: "device" | "vm"
  id: string
  name: string
  /** The installs on it of the applications shown. */
  installs: InstalledSoftware[]
  /** Each of its applications' colour, by application id. */
  colors?: Record<string, string>
}

/** What a card stands for. */
export type AppMapRef =
  | { kind: "application"; app: Application }
  | {
      kind: "host"
      host: AppHost
      /** Under applications: the application this copy of the host sits
       * under (its installs are that application's alone). */
      app?: string
    }
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
  /** An application's colour: a thin bar on the card's left edge. */
  accent?: string
}

/** How a line ends: arrowheads at the target, the source, both or none. */
export type AppArrow = "end" | "start" | "both" | "none"

export type AppEdgeData = DiagramEdgeData & {
  kind: "child" | "install" | "flow"
  /** Flow lines: the flows between the two cards, both ways. */
  flows?: ApplicationFlow[]
  /** Install lines: what a hover shows ("Application · version"). */
  tip?: string
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
  /** Tree: the gap above the Hosts row, where each application's install
   * lines run in a channel of their own (routing.ts). */
  hostGap?: { top: number; bottom: number }
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
  /** The gap above the Hosts row: this much per application with install
   * lines (its channel), and this much clear above and below them. */
  SLOT: 8,
  SLOT_PAD: 10,
} as const

/** The Flows' spacing: wider than the flow diagram's own, so each line
 * gets a channel of its own between two columns. */
export const FLOWS = {
  COL_GAP: 200,
  ROW_GAP: 36,
} as const

const NEUTRAL_LINE = "var(--muted-foreground)"

const cmp = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** The application palette: twelve hues at a middle lightness, each at
 * least 3:1 against both the light and the dark canvas, so one value
 * serves both themes and the exports. Neighbours differ in hue family. */
export const APP_COLORS = [
  "#2563eb",
  "#ea580c",
  "#059669",
  "#c026d3",
  "#0891b2",
  "#c2780a",
  "#7c3aed",
  "#db2777",
  "#0d9488",
  "#5a8f0e",
  "#6366f1",
  "#e11d48",
] as const

/** A stable pick from `APP_COLORS` for an id (FNV-1a): the same on every
 * load. */
export function paletteColor(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return APP_COLORS[(h >>> 0) % APP_COLORS.length]
}

/** An application's first coloured tag's colour, or null. */
export function tagColor(app: Pick<Application, "tags">): string | null {
  const tag = app.tags.find((t) => !!cssColor(t.color))
  return tag ? (cssColor(tag.color) ?? null) : null
}

/** An application's colour: its first coloured tag's, else its pick from
 * the palette. Its card's edge, its install lines and its name in a
 * host's panel wear it. */
export function applicationColor(
  app: Pick<Application, "id" | "tags">
): string {
  return tagColor(app) ?? paletteColor(app.id)
}

/** An application card's text: the name, and its installs and flows. The
 * card stays neutral: its colour is the bar on its edge. */
export function applicationCard(app: Application): CardLayoutInput {
  return {
    name: app.name,
    color: null,
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
  /** The hosts: a row of them (true, the default), a copy under each
   * application (`under`), or none (false, `off`). */
  hosts?: boolean | HostsMode
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
  const colors = new Map<string, string>()
  for (const a of ordered) {
    const input = applicationCard(a)
    const box = cardLayout(input, null, opts.measure)
    const id = `app:${a.id}`
    const color = applicationColor(a)
    colors.set(a.id, color)
    const n = cardNode(id, { kind: "application", app: a }, input, box)
    n.data.accent = color
    nodes.push(n)
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
  const mode = hostsMode(opts.hosts)
  // The hosts' cards, and what each wants to sit under: a row's host the
  // mean of its applications, a copy the one application it sits under.
  const hostCards: { id: string; apps: string[]; under?: string }[] = []
  if (mode !== "off") {
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
    const installLine = (
      appId: string,
      id: string,
      list: InstalledSoftware[]
    ) =>
      linkEdge(`install:${appId}:${id}`, `app:${appId}`, id, "elbow", {
        kind: "install",
        arrow: "none",
        tip: installTip(list),
        paint: { stroke: colors.get(appId), width: 1.25, dash: "4 3" },
      })
    for (const h of sorted) {
      const key = hostKey(h.kind, h.id)
      const appIds = [
        ...new Set(h.installs.map((i) => i.application.id)),
      ].sort()
      h.colors = Object.fromEntries(appIds.map((a) => [a, colors.get(a)!]))
      // A VM is dashed, as on the topology's Logical tab.
      const extra = h.kind === "vm" ? { panel: true } : {}
      if (mode === "row") {
        const input: CardLayoutInput = { name: h.name, color: null, lines: [] }
        const box = cardLayout(input, null, opts.measure)
        nodes.push(cardNode(key, { kind: "host", host: h }, input, box, extra))
        tier.set(key, hostTier)
        hostCards.push({ id: key, apps: appIds.map((a) => `app:${a}`) })
        for (const appId of appIds)
          edges.push(
            installLine(
              appId,
              key,
              h.installs.filter((i) => i.application.id === appId)
            )
          )
        continue
      }
      // Under applications: a copy of the host per application, with the
      // version installed.
      for (const appId of appIds) {
        const mine = h.installs.filter((i) => i.application.id === appId)
        const id = `leaf:${appId}:${key.slice("host:".length)}`
        const input: CardLayoutInput = {
          name: h.name,
          color: null,
          lines: [{ key: "version", text: versionsOf(mine) || "-" }],
        }
        const box = cardLayout(input, null, opts.measure)
        nodes.push(
          cardNode(
            id,
            { kind: "host", host: { ...h, installs: mine }, app: appId },
            input,
            box,
            extra
          )
        )
        tier.set(id, hostTier)
        hostCards.push({ id, apps: [`app:${appId}`], under: `app:${appId}` })
        edges.push(installLine(appId, id, mine))
      }
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
  // The gap above the Hosts row holds a channel per application with
  // install lines.
  const lined = new Set(
    edges.filter((e) => e.data!.kind === "install").map((e) => e.source)
  )
  const hostGapH = Math.max(
    TREE.BAND_GAP,
    lined.size * TREE.SLOT + 2 * TREE.SLOT_PAD
  )
  // Each row's top, under its band's title strip.
  const tops: number[] = []
  let hostGap: AppMapGraph["hostGap"]
  let y = BAND.TITLE + TREE.PAD_TOP
  for (let t = 0; t < levels; t++) {
    if (t > 0) {
      const above = tops[t - 1] + heights[t - 1] + TREE.PAD_BOTTOM
      const gap = t === hostTier ? hostGapH : TREE.BAND_GAP
      if (t === hostTier)
        hostGap = {
          top: above + TREE.SLOT_PAD,
          bottom: above + gap - TREE.SLOT_PAD,
        }
      y = above + gap + BAND.TITLE + TREE.PAD_TOP
    }
    tops.push(y)
  }
  const xOf = (id: string) => (g.node(id) as { x: number }).x
  for (const n of nodes) {
    const t = tier.get(n.id)!
    n.position = { x: Math.round(xOf(n.id)), y: tops[t] + heights[t] / 2 }
  }

  // The hosts in their row: each under the mean of its applications (one
  // application's host right under it, a copy under its application), in
  // that order, pushed apart only as far as they must be.
  if (hostCards.length) {
    const width = new Map(nodes.map((n) => [n.id, n.width ?? 0]))
    const want = (c: (typeof hostCards)[number]) =>
      c.apps.reduce((s, a) => s + xOf(a), 0) / c.apps.length
    // Copies under one application go side by side, as one block.
    const blocks = new Map<string, { ids: string[]; want: number }>()
    for (const c of hostCards) {
      const k = c.under ?? c.id
      const b = blocks.get(k) ?? { ids: [], want: want(c) }
      b.ids.push(c.id)
      blocks.set(k, b)
    }
    const span = (ids: string[]) =>
      ids.reduce((s, id) => s + width.get(id)!, 0) +
      (ids.length - 1) * TREE.NODE_GAP
    const placed = packRow(
      [...blocks.entries()].map(([k, b]) => ({
        key: k,
        w: span(b.ids),
        want: b.want,
      })),
      TREE.NODE_GAP
    )
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const [k, b] of blocks) {
      let x = placed.get(k)! - span(b.ids) / 2
      for (const id of b.ids) {
        const n = byId.get(id)!
        n.position = { ...n.position, x: Math.round(x + width.get(id)! / 2) }
        x += width.get(id)! + TREE.NODE_GAP
      }
    }
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
  return routeGraph(
    { nodes, edges, bands, ...(hostGap ? { hostGap } : {}) },
    opts.measure
  )
}

/** The versions among installs, once each: "1.2, 1.3". */
function versionsOf(list: readonly InstalledSoftware[]): string {
  return [...new Set(list.map((i) => i.version).filter(Boolean))]
    .sort(cmp)
    .join(", ")
}

/** An install line's hover text: "Application · version". */
function installTip(list: readonly InstalledSoftware[]): string {
  const v = versionsOf(list)
  return `${list[0]?.application.name ?? ""}${v ? ` · ${v}` : ""}`
}

/**
 * Boxes in one row, each centred as near its `want` as it can be: in
 * order of `want`, those that would overlap pushed apart as one cluster
 * centred on their wants' mean, `gap` px between neighbours. Returns each
 * box's centre.
 */
export function packRow(
  items: readonly { key: string; w: number; want: number }[],
  gap: number
): Map<string, number> {
  type Cluster = { keys: string[]; ws: number[]; left: number; w: number }
  const sorted = [...items].sort((a, b) => a.want - b.want || cmp(a.key, b.key))
  const wantOf = new Map(items.map((i) => [i.key, i.want]))
  // The left edge that best centres every box of a cluster on its want.
  const bestLeft = (c: Cluster) => {
    let off = 0
    let sum = 0
    c.keys.forEach((k, i) => {
      sum += wantOf.get(k)! - c.ws[i] / 2 - off
      off += c.ws[i] + gap
    })
    return sum / c.keys.length
  }
  const out: Cluster[] = []
  for (const it of sorted) {
    let c: Cluster = {
      keys: [it.key],
      ws: [it.w],
      left: it.want - it.w / 2,
      w: it.w,
    }
    for (;;) {
      const prev = out.at(-1)
      if (!prev || prev.left + prev.w + gap <= c.left) break
      out.pop()
      c = {
        keys: [...prev.keys, ...c.keys],
        ws: [...prev.ws, ...c.ws],
        left: 0,
        w: prev.w + gap + c.w,
      }
      c.left = bestLeft(c)
    }
    out.push(c)
  }
  const centres = new Map<string, number>()
  for (const c of out) {
    let x = c.left
    c.keys.forEach((k, i) => {
      centres.set(k, x + c.ws[i] / 2)
      x += c.ws[i] + gap
    })
  }
  return centres
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
    // Room for a channel per line, and the ends many lines meet at the
    // top or bottom of their column, so their fans do not cross it.
    colGap: FLOWS.COL_GAP,
    rowGap: FLOWS.ROW_GAP,
    hubsOut: true,
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
  return routeGraph({ nodes, edges, bands }, opts.measure)
}

// ── Shared ────────────────────────────────────────────────────────────────

/** What hovering or selecting a card brings forward: the card, its
 * install or flow lines and the cards at their other ends (an
 * application's hosts, a host's applications). Null for no card. */
export function focusSet(
  graph: AppMapGraph,
  id: string | null | undefined
): { nodes: Set<string>; edges: Set<string> } | null {
  if (!id || !graph.nodes.some((n) => n.id === id)) return null
  const nodes = new Set([id])
  const edges = new Set<string>()
  for (const e of graph.edges) {
    if (e.data?.kind === "child") continue
    if (e.source !== id && e.target !== id) continue
    edges.add(e.id)
    nodes.add(e.source)
    nodes.add(e.target)
  }
  return { nodes, edges }
}

/** Cards moved by hand (centres, by id) put where they were left. */
export function withPositions(
  graph: AppMapGraph,
  positions: Readonly<Record<string, readonly [number, number]>> | undefined
): AppMapGraph {
  if (!positions || !Object.keys(positions).length) return graph
  // The lines planned again round the cards where they now stand.
  return routeGraph({
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (!Object.hasOwn(positions, n.id)) return n
      const [x, y] = positions[n.id]
      return { ...n, position: { x, y } }
    }),
  })
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
  if (!hidden.size || !graph.nodes.some((n) => hidden.has(n.id))) return graph
  return routeGraph({
    ...graph,
    nodes: graph.nodes.filter((n) => !hidden.has(n.id)),
    edges: graph.edges.filter(
      (e) => !hidden.has(e.source) && !hidden.has(e.target)
    ),
  })
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
