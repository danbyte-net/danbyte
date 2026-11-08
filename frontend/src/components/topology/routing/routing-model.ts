import type {
  RoutingAsGroup,
  RoutingCardField,
  RoutingCheckKind,
  RoutingDisplay,
  RoutingEdge,
  RoutingLayer,
  RoutingNode,
  RoutingRouterData,
  RoutingTopology,
  RoutingVrf,
} from "@/lib/api"
import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { naturalCompare } from "@/lib/natural-sort"
import { cardLayout } from "../diagram/card-layout"
import type { CardBox, CardLayoutInput } from "../diagram/card-layout"
import { groupBox } from "../group-size"
import type { TopoHidden } from "../hidden"
import { ZONE_COLORS } from "../view-positions"
import type { PosMap, Zone } from "../view-positions"

// The Routing tab's picture, worked out in code: which layers draw, what a
// router card says, how a line looks and what it is labelled, and where
// Arrange ▸ By AS puts the AS boxes and their cards. The canvas, the
// sidebar, the legend and the exports all read these, so they agree.

/** The line layers, in legend order. Each is an edge type too (`layerOf`). */
export const ROUTING_LAYERS: readonly { key: RoutingLayer; label: string }[] = [
  { key: "ebgp", label: "eBGP" },
  { key: "ibgp", label: "iBGP" },
  { key: "ospf", label: "OSPF" },
  { key: "isis", label: "IS-IS" },
  { key: "static", label: "Static" },
  { key: "circuits", label: "Circuits" },
  { key: "cables", label: "Cables" },
]

/** On unless a view turns them off - cables, the Diagram's subject, start
 * off here. */
export const DEFAULT_LAYERS: Readonly<Record<RoutingLayer, boolean>> = {
  ebgp: true,
  ibgp: true,
  ospf: true,
  isis: true,
  static: true,
  circuits: true,
  cables: false,
}

/** The layers the map always asks the server for; cables come only while
 * their layer is on. */
export const FETCHED_LAYERS: readonly RoutingLayer[] = [
  "ebgp",
  "ibgp",
  "ospf",
  "isis",
  "static",
  "circuits",
]

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A table the picker can name: `all`, `global` or a VRF id. Anything
 * else - nothing picked, as in a view saved before the picker - reads as
 * every table. */
export function readVrf(raw: unknown): RoutingVrf {
  if (raw === "global") return "global"
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw.toLowerCase()
  return "all"
}

/** What each Checks item is called in the chip's list. */
export const CHECK_LABELS: Record<RoutingCheckKind, string> = {
  bgp_one_sided: "One-sided session",
  bgp_as_mismatch: "AS mismatch",
  ospf_area: "Area mismatch",
  ospf_timers: "Hello/dead mismatch",
  ospf_mtu: "MTU mismatch",
  isis_level: "Level mismatch",
}

/** The Checks kinds on a line (none for circuits and cables). */
export function problemsOf(e: RoutingEdge): readonly RoutingCheckKind[] {
  if (e.type === "circuit" || e.type === "cable") return []
  return e.data.problems ?? []
}

/** A line drawn over a red halo: the Checks chip is on and names it. */
export const isFlagged = (
  e: RoutingEdge,
  s: Pick<RoutingSettings, "checks">
): boolean => s.checks && problemsOf(e).length > 0

/** A router card's possible lines, in the order a card lists them. */
export const ROUTING_FIELDS: readonly {
  key: RoutingCardField
  label: string
}[] = [
  { key: "role", label: "Role" },
  { key: "router_id", label: "Router ID" },
  { key: "asn", label: "ASN" },
  { key: "loopback", label: "Loopback" },
  { key: "site", label: "Site" },
  { key: "primary_ip", label: "Primary IP" },
  { key: "status", label: "Status" },
]

export const DEFAULT_FIELDS: readonly RoutingCardField[] = [
  "router_id",
  "asn",
  "loopback",
]

export type RoutingMode = "simple" | "detailed"

/** `filters.routing` as the tab uses it: every layer named, the card
 * lines in their own order. Anything unknown reads as its default. */
export interface RoutingSettings {
  mode: RoutingMode
  layers: Record<RoutingLayer, boolean>
  fields: RoutingCardField[]
  /** The table drawn. */
  vrf: RoutingVrf
  /** The Checks chip on the map. */
  checks: boolean
}

export function readRoutingDisplay(raw: unknown): RoutingSettings {
  const d = (raw && typeof raw === "object" ? raw : {}) as RoutingDisplay
  const layers = { ...DEFAULT_LAYERS }
  if (d.layers && typeof d.layers === "object")
    for (const { key } of ROUTING_LAYERS) {
      const v = (d.layers as Record<string, unknown>)[key]
      if (typeof v === "boolean") layers[key] = v
    }
  const fields = Array.isArray(d.fields)
    ? ROUTING_FIELDS.map((f) => f.key).filter((k) => d.fields!.includes(k))
    : [...DEFAULT_FIELDS]
  return {
    mode: d.mode === "simple" ? "simple" : "detailed",
    layers,
    fields,
    vrf: readVrf(d.vrf),
    checks: d.checks === true,
  }
}

/** The settings as a view saves them: only what differs from the
 * defaults. */
export function routingDisplay(s: RoutingSettings): RoutingDisplay {
  const out: RoutingDisplay = { mode: s.mode }
  const layers: RoutingDisplay["layers"] = {}
  for (const { key } of ROUTING_LAYERS)
    if (s.layers[key] !== DEFAULT_LAYERS[key]) layers[key] = s.layers[key]
  if (Object.keys(layers).length) out.layers = layers
  const same =
    s.fields.length === DEFAULT_FIELDS.length &&
    s.fields.every((f, i) => f === DEFAULT_FIELDS[i])
  if (!same) out.fields = s.fields
  if (s.vrf !== "all") out.vrf = s.vrf
  if (s.checks) out.checks = true
  return out
}

/** The layer an edge is drawn on. */
export function layerOf(e: Pick<RoutingEdge, "type">): RoutingLayer {
  switch (e.type) {
    case "ebgp":
    case "ibgp":
    case "ospf":
    case "isis":
    case "static":
      return e.type
    case "circuit":
      return "circuits"
    default:
      return "cables"
  }
}

/** Each line's lane among the lines between the same two cards: 0 alone,
 * ±0.5 for two, -1, 0, 1 for three (routing-edge.tsx `laneEnds`). */
export function edgeLanes(
  edges: readonly Pick<RoutingEdge, "id" | "source" | "target">[]
): Map<string, number> {
  const pairs = new Map<string, string[]>()
  for (const e of edges) {
    const key = [e.source, e.target].sort().join("|")
    pairs.set(key, [...(pairs.get(key) ?? []), e.id])
  }
  const out = new Map<string, number>()
  for (const ids of pairs.values())
    ids.forEach((id, i) => out.set(id, i - (ids.length - 1) / 2))
  return out
}

/** The layers the map asks the server for: those switched on. */
export function wantedLayers(
  layers: Record<RoutingLayer, boolean>
): RoutingLayer[] {
  return ROUTING_LAYERS.map((l) => l.key).filter((k) => layers[k])
}

// ── Labels ─────────────────────────────────────────────────────────────────

const AF_SHORT: Record<string, string> = {
  "ipv4-unicast": "v4",
  "ipv6-unicast": "v6",
  "vpnv4-unicast": "vpnv4",
  "vpnv6-unicast": "vpnv6",
  "l2vpn-evpn": "evpn",
  "ipv4-labeled-unicast": "v4 LU",
}

/** An address family as a line label writes it: v4, v6, vpnv4, evpn… */
export const afShort = (afi: string) => AF_SHORT[afi] ?? afi

const asText = (asn: number | null | undefined) =>
  asn === null || asn === undefined ? "AS?" : `AS${asn}`

/** What a line says along it, row by row: an eBGP line its two ASes, then
 * its families and VRF; an iBGP line its families, "RR client" and the
 * cluster ID (only what is worth saying); a circuit its ID. */
export function routingEdgeLabel(e: RoutingEdge): string[] {
  if (e.type === "ebgp" || e.type === "ibgp") {
    const d = e.data
    const afs = d.address_families.map(afShort)
    const tail = [...afs, ...(d.vrf ? [`VRF ${d.vrf}`] : [])].join(" · ")
    if (e.type === "ebgp")
      return [
        `${asText(d.a_asn)} ⇄ ${asText(d.b_asn)}`,
        ...(tail ? [tail] : []),
      ]
    const plain =
      !d.vrf &&
      (afs.length === 0 || (afs.length === 1 && afs[0] === "v4")) &&
      !d.rr
    if (plain) return []
    const rr = d.rr
      ? [
          "RR client",
          ...(d.rr.cluster_id ? [`cluster ${d.rr.cluster_id}`] : []),
        ]
      : []
    return [[...afs, ...(d.vrf ? [`VRF ${d.vrf}`] : []), ...rr].join(" · ")]
  }
  if (e.type === "ospf") {
    const d = e.data
    const [ca, cb] = d.cost
    const head = [
      d.area !== null ? `area ${d.area}` : `area ${d.areas[0]} ⇄ ${d.areas[1]}`,
      ...(d.version === 3 ? ["v3"] : []),
      ...(d.links.length > 1 ? [`${d.links.length}x`] : []),
      ...(d.vrf ? [`VRF ${d.vrf}`] : []),
    ].join(" · ")
    return ca !== cb ? [head, `cost ${ca ?? "-"} ⇄ ${cb ?? "-"}`] : [head]
  }
  if (e.type === "isis") {
    const d = e.data
    const [ma, mb] = d.metric
    const level =
      d.level !== null
        ? isisLevel(d.level)
        : `${isisLevel(d.levels[0])} ⇄ ${isisLevel(d.levels[1])}`
    const metric =
      ma === mb
        ? ma !== null
          ? `metric ${ma}`
          : null
        : `metric ${ma ?? "-"} ⇄ ${mb ?? "-"}`
    return [
      [
        level,
        ...(metric ? [metric] : []),
        ...(d.links.length > 1 ? [`${d.links.length}x`] : []),
        ...(d.vrf ? [`VRF ${d.vrf}`] : []),
      ].join(" · "),
    ]
  }
  if (e.type === "static") {
    const n = e.data.count
    return [
      [
        `${n} route${n === 1 ? "" : "s"}`,
        ...(e.data.vrf ? [`VRF ${e.data.vrf}`] : []),
      ].join(" · "),
    ]
  }
  if (e.type === "circuit")
    return e.data.circuit?.cid ? [e.data.circuit.cid] : []
  return e.data.cables.length > 1 ? [`${e.data.cables.length}x`] : []
}

/** An IS-IS level as a label writes it: L1, L2, L1-2. */
export const isisLevel = (level: string | null | undefined) =>
  level ? `L${level}` : "L?"

export const KIND_NAME: Record<RoutingEdge["type"], string> = {
  ebgp: "eBGP",
  ibgp: "iBGP",
  ospf: "OSPF",
  isis: "IS-IS",
  static: "Static",
  circuit: "Circuit",
  cable: "Cable",
}

/** A line's name: its two ends and what it is ("r1 ⇄ isp1 · eBGP"). */
export function routingEdgeTitle(
  e: RoutingEdge,
  name: (id: string) => string
): string {
  const arrow = e.type === "static" ? "→" : "⇄"
  return `${name(e.source)} ${arrow} ${name(e.target)} · ${KIND_NAME[e.type]}`
}

// ── Looks ──────────────────────────────────────────────────────────────────

/** eBGP colours: one per AS pair, picked by the pair so the same two ASes
 * always draw the same colour. Distinct hues, none a status colour. */
export const AS_PAIR_COLORS = [
  "#2563eb",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4f46e5",
  "#0d9488",
  "#c2410c",
] as const

/** The colour of the eBGP line between two ASes, whichever end is which. */
export function asPairColor(a: number | null, b: number | null): string {
  const key = [a ?? 0, b ?? 0].sort((x, y) => x - y).join("-")
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AS_PAIR_COLORS[h % AS_PAIR_COLORS.length]
}

export const IBGP_COLOR = "#475569"
export const CIRCUIT_COLOR = "#64748b"
export const CABLE_COLOR = "#94a3b8"
export const CIRCUIT_DASH = "10 4 2 4"
export const OSPF_COLOR = "#0e7490"
export const OSPF_DASH = "6 4"
export const ISIS_COLOR = "#9333ea"
export const ISIS_DASH = "2 3"
export const STATIC_COLOR = "#57534e"

export interface RoutingEdgeLook {
  stroke: string
  width: number
  dash?: string
  /** An arrowhead at the target: a route reflector's line to its client. */
  arrow: boolean
  /** Drawn faint, under the rest. */
  faint: boolean
}

/** How a line is drawn: eBGP solid and thick in its AS pair's colour, iBGP
 * thin (an arrow from a route reflector to its client), OSPF and IS-IS
 * dashed each in its own colour, static routes a thin arrow to the next
 * hop, a circuit dash-dot in its type's colour, a cable faint. */
export function routingEdgeLook(e: RoutingEdge): RoutingEdgeLook {
  switch (e.type) {
    case "ospf":
      return {
        stroke: OSPF_COLOR,
        width: 2,
        dash: OSPF_DASH,
        arrow: false,
        faint: false,
      }
    case "isis":
      return {
        stroke: ISIS_COLOR,
        width: 2,
        dash: ISIS_DASH,
        arrow: false,
        faint: false,
      }
    case "static":
      return { stroke: STATIC_COLOR, width: 1, arrow: true, faint: false }
    case "ebgp":
      return {
        stroke: asPairColor(e.data.a_asn, e.data.b_asn),
        width: 3,
        arrow: false,
        faint: false,
      }
    case "ibgp":
      return {
        stroke: IBGP_COLOR,
        width: 1.25,
        arrow: !!e.data.rr,
        faint: false,
      }
    case "circuit": {
      const c = (e.data.color ?? "").replace(/^#/, "")
      return {
        stroke: /^[0-9a-f]{6}$/i.test(c)
          ? `#${c.toLowerCase()}`
          : CIRCUIT_COLOR,
        width: 2,
        dash: CIRCUIT_DASH,
        arrow: false,
        faint: false,
      }
    }
    default:
      return { stroke: CABLE_COLOR, width: 1, arrow: false, faint: true }
  }
}

// ── Cards ──────────────────────────────────────────────────────────────────

/** A router's ASNs, each once: `AS65100` for an AS its global table runs
 * (its VRF instances of the same AS add nothing to a card), `AS65200 (VRF
 * red)` for one only VRFs run. `full` (the panel) names those VRFs too:
 * `AS65100 (global, VRF red)`. */
export function asnsText(
  asns: readonly { asn: number; vrf: string | null }[],
  full = false
): string {
  const by = new Map<number, (string | null)[]>()
  for (const a of asns) by.set(a.asn, [...(by.get(a.asn) ?? []), a.vrf])
  return [...by]
    .map(([asn, vrfs]) => {
      const named = vrfs.filter((v): v is string => !!v)
      const global = named.length < vrfs.length
      if (!named.length) return `AS${asn}`
      if (global && !full) return `AS${asn}`
      const list = named.map((v) => `VRF ${v}`).join(", ")
      return global ? `AS${asn} (global, ${list})` : `AS${asn} (${list})`
    })
    .join(", ")
}

/** A router card's lines in the order the fields list them; Simple keeps
 * the name and its AS. */
export function routerLines(
  d: RoutingRouterData,
  mode: RoutingMode,
  fields: readonly RoutingCardField[]
): { key: string; text: string }[] {
  const wanted = mode === "simple" ? fields.filter((f) => f === "asn") : fields
  const out: { key: string; text: string }[] = []
  for (const f of wanted) {
    let text: string | null = null
    if (f === "role") text = d.role?.name ?? null
    else if (f === "router_id") text = d.router_id ? `RID ${d.router_id}` : null
    else if (f === "asn")
      text = d.asns.length
        ? asnsText(d.asns)
        : d.as_group !== null
          ? `AS${d.as_group}`
          : null
    else if (f === "loopback") text = d.loopback ? `lo ${d.loopback}` : null
    else if (f === "site") text = d.site
    else if (f === "primary_ip") text = d.primary_ip
    else text = d.status_mini?.name ?? null
    if (text) out.push({ key: f, text })
  }
  return out
}

export function routerCardInput(
  d: RoutingRouterData,
  mode: RoutingMode,
  fields: readonly RoutingCardField[]
): CardLayoutInput {
  return {
    name: d.name,
    color: d.role?.color,
    lines: routerLines(d, mode, fields),
  }
}

/** A router card's box: the Diagram card's own sizing, so its name is
 * never cut. */
export function routerBox(
  d: RoutingRouterData,
  mode: RoutingMode,
  fields: readonly RoutingCardField[],
  measure: Measure = measureText
): CardBox {
  return cardLayout(routerCardInput(d, mode, fields), null, measure)
}

/** Every node's size on the tab. */
export function nodeSizes(
  nodes: readonly RoutingNode[],
  mode: RoutingMode,
  fields: readonly RoutingCardField[],
  measure: Measure = measureText
): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>()
  for (const n of nodes) {
    if (n.type === "router") {
      const b = routerBox(n.data, mode, fields, measure)
      out.set(n.id, { w: b.w, h: b.h })
    } else {
      const b = groupBox(n.data, measure)
      out.set(n.id, { w: b.width, h: b.height })
    }
  }
  return out
}

// ── What is shown ──────────────────────────────────────────────────────────

/** The map with what the eyes took off: layers switched off, cards
 * hidden one by one or by role or site, lines hidden one by one, and the
 * lines whose ends are gone. */
export function shownRouting(
  g: RoutingTopology,
  layers: Record<RoutingLayer, boolean>,
  hidden: TopoHidden
): RoutingTopology {
  const nodes = g.nodes.filter((n) => {
    if (hidden.devices.includes(n.id)) return false
    if (n.type !== "router") return layers.circuits
    const d = n.data
    if (d.role && hidden.roles.includes(d.role.name)) return false
    if (d.site && hidden.sites.includes(d.site)) return false
    return true
  })
  const on = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter(
    (e) =>
      layers[layerOf(e)] &&
      !hidden.edges.includes(e.id) &&
      on.has(e.source) &&
      on.has(e.target)
  )
  // A provider network with none of its circuits drawn is not on the map.
  const reached = new Set(edges.flatMap((e) => [e.source, e.target]))
  return {
    ...g,
    nodes: nodes.filter((n) => n.type === "router" || reached.has(n.id)),
    edges,
  }
}

/** How many of this map's objects the eyes took off (the Hidden chip). */
export function hiddenRouting(g: RoutingTopology, hidden: TopoHidden): number {
  const ids = new Set([
    ...g.nodes.map((n) => n.id),
    ...g.edges.map((e) => e.id),
  ])
  return (
    hidden.devices.filter((id) => ids.has(id)).length +
    hidden.edges.filter((id) => ids.has(id)).length
  )
}

// ── Arrange ▸ By AS ────────────────────────────────────────────────────────

export const AS_BOX = {
  /** Inside a box, round its cards. */
  PAD: 28,
  /** Above the cards: the box's name. */
  TITLE: 30,
  GAP_X: 48,
  GAP_Y: 56,
  /** Between boxes. */
  BETWEEN: 72,
  /** Cards a row holds before it wraps. */
  COLS: 6,
} as const

/** An AS box's name: the AS, then its ASN's name. */
export const asBoxLabel = (g: Pick<RoutingAsGroup, "asn" | "name">) =>
  g.name ? `AS${g.asn} · ${g.name}` : `AS${g.asn}`

/** The AS box id Arrange gives a box, so it finds it again. */
export const asZoneId = (asn: number) => `as${asn}`

type Sized = { id: string; w: number; h: number; role: string; name: string }

/** Rows of cards: by role (in `roleOrder`, then by name), each wrapped at
 * `AS_BOX.COLS`. */
function rowsOf(cards: Sized[], roleOrder: readonly string[]): Sized[][] {
  const rank = (r: string) => {
    const i = roleOrder.indexOf(r)
    return i < 0 ? roleOrder.length : i
  }
  const byRole = new Map<string, Sized[]>()
  for (const c of cards) byRole.set(c.role, [...(byRole.get(c.role) ?? []), c])
  const roles = [...byRole.keys()].sort(
    (a, b) => rank(a) - rank(b) || naturalCompare(a, b)
  )
  const rows: Sized[][] = []
  for (const r of roles) {
    const list = byRole.get(r)!.sort((a, b) => naturalCompare(a.name, b.name))
    for (let i = 0; i < list.length; i += AS_BOX.COLS)
      rows.push(list.slice(i, i + AS_BOX.COLS))
  }
  return rows
}

/** Cards in rows, centred on each row, from (0, 0): their centres and the
 * block's size. */
function blockOf(rows: Sized[][]): {
  at: PosMap
  w: number
  h: number
} {
  const widths = rows.map(
    (r) => r.reduce((s, c) => s + c.w, 0) + AS_BOX.GAP_X * (r.length - 1)
  )
  const w = Math.max(0, ...widths)
  const at: PosMap = {}
  let y = 0
  rows.forEach((r, i) => {
    const rh = Math.max(...r.map((c) => c.h))
    let x = (w - widths[i]) / 2
    for (const c of r) {
      at[c.id] = [Math.round(x + c.w / 2), Math.round(y + rh / 2)]
      x += c.w + AS_BOX.GAP_X
    }
    y += rh + AS_BOX.GAP_Y
  })
  return { at, w, h: Math.max(0, y - AS_BOX.GAP_Y) }
}

/**
 * Arrange ▸ By AS: one box per AS, its cards in rows by role inside it, the
 * boxes packed left to right in shelves; the cards in no AS after them,
 * and the provider networks in a row below everything. An AS box already
 * drawn keeps its name and colour; zones that are not AS boxes stay where
 * they are. Returns every card's centre and the boxes.
 */
export function arrangeByAs(
  g: Pick<RoutingTopology, "nodes" | "as_groups">,
  sizes: ReadonlyMap<string, { w: number; h: number }>,
  opts: { roleOrder?: readonly string[]; zones?: readonly Zone[] } = {}
): { positions: PosMap; zones: Zone[] } {
  const roleOrder = opts.roleOrder ?? []
  const sized = (n: RoutingNode): Sized => {
    const s = sizes.get(n.id) ?? { w: 120, h: 40 }
    return {
      id: n.id,
      w: s.w,
      h: s.h,
      role: n.type === "router" ? (n.data.role?.name ?? "") : "",
      name: n.data.name,
    }
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const boxed = new Set<string>()
  type Block = {
    asn: number | null
    label: string
    at: PosMap
    w: number
    h: number
  }
  const blocks: Block[] = []
  for (const grp of [...g.as_groups].sort((a, b) => a.asn - b.asn)) {
    const cards = grp.nodes.flatMap((id) => {
      const n = byId.get(id)
      if (!n || boxed.has(id)) return []
      boxed.add(id)
      return [sized(n)]
    })
    if (!cards.length) continue
    const b = blockOf(rowsOf(cards, roleOrder))
    blocks.push({
      asn: grp.asn,
      label: asBoxLabel(grp),
      at: b.at,
      w: b.w + 2 * AS_BOX.PAD,
      h: b.h + 2 * AS_BOX.PAD + AS_BOX.TITLE,
    })
  }
  const loose = g.nodes
    .filter((n) => n.type === "router" && !boxed.has(n.id))
    .map(sized)
  if (loose.length) {
    const b = blockOf(rowsOf(loose, roleOrder))
    blocks.push({
      asn: null,
      label: "",
      at: b.at,
      w: b.w + 2 * AS_BOX.PAD,
      h: b.h + 2 * AS_BOX.PAD + AS_BOX.TITLE,
    })
  }

  // Shelves about as wide as the boxes would be in a square.
  const area = blocks.reduce((s, b) => s + b.w * b.h, 0)
  const shelfW = Math.max(
    1200,
    Math.sqrt(area) * 1.6,
    ...blocks.map((b) => b.w)
  )
  const positions: PosMap = {}
  const old = new Map(
    (opts.zones ?? []).filter((z) => z.asn !== undefined).map((z) => [z.asn, z])
  )
  const zones: Zone[] = []
  let x = 0
  let y = 0
  let shelfH = 0
  let colour = 0
  for (const b of blocks) {
    if (x > 0 && x + b.w > shelfW) {
      x = 0
      y += shelfH + AS_BOX.BETWEEN
      shelfH = 0
    }
    const ox = x + AS_BOX.PAD
    const oy = y + AS_BOX.PAD + AS_BOX.TITLE
    for (const [id, [cx, cy]] of Object.entries(b.at))
      positions[id] = [ox + cx, oy + cy]
    if (b.asn !== null) {
      const was = old.get(b.asn)
      zones.push({
        id: was?.id ?? asZoneId(b.asn),
        label: was?.label || b.label,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(b.w),
        h: Math.round(b.h),
        color: was?.color ?? ZONE_COLORS[(1 + colour) % ZONE_COLORS.length],
        asn: b.asn,
      })
      colour++
    }
    x += b.w + AS_BOX.BETWEEN
    shelfH = Math.max(shelfH, b.h)
  }
  // The provider networks, in a row under it all.
  const clouds = g.nodes.filter((n) => n.type !== "router").map(sized)
  if (clouds.length) {
    const top = blocks.length ? y + shelfH + AS_BOX.BETWEEN : 0
    const b = blockOf([clouds])
    for (const [id, [cx, cy]] of Object.entries(b.at))
      positions[id] = [cx, top + cy]
  }
  // Zones drawn by hand stay as they are.
  const kept = (opts.zones ?? []).filter((z) => z.asn === undefined)
  return { positions, zones: [...kept, ...zones] }
}

/** The cards inside a box: their centres within it. */
export function cardsInside(
  zone: Pick<Zone, "x" | "y" | "w" | "h">,
  centres: PosMap
): string[] {
  return Object.entries(centres)
    .filter(
      ([, [x, y]]) =>
        x >= zone.x &&
        x <= zone.x + zone.w &&
        y >= zone.y &&
        y <= zone.y + zone.h
    )
    .map(([id]) => id)
}
