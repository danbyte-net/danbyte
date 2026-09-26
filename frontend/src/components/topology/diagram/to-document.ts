import type { CSSProperties } from "react"
import type { Edge, Node } from "@xyflow/react"

import type {
  CheckStatus,
  TopoNode,
  TopologyViewNote,
  TopologyViewZone,
} from "@/lib/api"
import { readableText } from "@/lib/color"
import { documentBounds } from "@/lib/diagram/geometry"
import type { Measure } from "@/lib/diagram/measure"
import {
  LINK_DEFAULTS,
  NEUTRAL_CARD,
  PRINT,
  hex6,
  printColor,
} from "@/lib/diagram/theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramEnd,
  DiagramLink,
  DiagramMeta,
  DiagramNode,
  DiagramNote,
  DiagramNub,
  DiagramPill,
  LegendRow,
  LinkSem,
  Side as DocSide,
} from "@/lib/diagram/types"
import type { LegendItem } from "../legend"
import { linkEnds } from "./anchors"
import type { Nub } from "./anchors"
import { relinkDiagram } from "./build-diagram"
import type { DiagramModel } from "./build-diagram"
import { cardContent } from "./card-fields"
import type { CardPill } from "./card-fields"
import { cardLayout, nubRect } from "./card-layout"
import type { CardBox, CardLayoutInput } from "./card-layout"
import { elbowChannel, linkRoute } from "./link-geometry"
import type {
  Anchor,
  DiagramEdgeData,
  DiagramMode,
  End,
  Pt,
  Rect,
  Route,
  Side,
} from "./types"

// The Diagram as an export document (lib/diagram/types.ts): what the SVG,
// PNG and draw.io writers draw. Built from the pipeline's model and where
// the cards are now - never the DOM, which holds only what is on screen.
// Only what the map means reaches the file: hidden cards and links are
// left out, and selection, hover, search dimming and the zoom level of
// detail never get in. Colours are the light print theme's, whatever theme
// the app is in.

/** A node as the canvas holds it: Diagram nodes are placed by their
 * centre. Only `id`, `position`, `hidden` and the payload `data` are read. */
export type LiveNode = Pick<Node, "id" | "position" | "hidden"> & {
  data?: unknown
}

/** An edge as the canvas holds it, anchored (Diagram link edges carry
 * their anchors in `data`). */
export type LiveEdge = Pick<
  Edge,
  "id" | "source" | "target" | "type" | "hidden" | "style"
> & { data?: unknown }

/** A zone or band box behind the cards (`zones_by_style.diagram`). */
export type Region = Pick<
  TopologyViewZone,
  "id" | "label" | "x" | "y" | "w" | "h" | "kind" | "orient"
> & { color?: string | null }

/** Monitoring state per device id (the canvas's `monitor` prop). */
export type MonitorMap = Readonly<
  Record<string, { status?: CheckStatus | null } | undefined>
>

/** The tenant's names and colours for the monitoring states. */
export type CheckLook = Partial<
  Record<CheckStatus, { name?: string | null; color?: string | null }>
>

export interface DocumentOptions {
  /** The file's mode; defaults to the canvas's. A Simple document of a
   * Detailed map drops the nubs, puts every line end at its side's
   * midpoint on the compact card, and folds a pair's cables into one line
   * - the shape the draw.io file defaults to. */
  mode?: DiagramMode
  /** Only the cards that touch this box (flow px), with the links between
   * them and the bands in it - "Visible area". */
  area?: Rect | null
  meta: Omit<DiagramMeta, "mode">
  notes?: readonly TopologyViewNote[]
  monitor?: MonitorMap
  checkLabels?: CheckLook
  /** Scheme and host for the links back, e.g. `https://danbyte.example`.
   * Without it links are site paths. */
  origin?: string
  measure?: Measure
}

// ── Shared pieces (the legacy adapter uses them too) ─────────────────────

const DOC_SIDE: Record<Side, DocSide> = {
  T: "top",
  R: "right",
  B: "bottom",
  L: "left",
}

/** Tailwind's red-500 and amber-500 (styles.css tokens) as print hex: the
 * shipped monitoring pill colours, when the tenant set none of its own. */
const CHECK_HEX: Partial<Record<CheckStatus, string>> = {
  down: "#fb2c36",
  degraded: "#fe9a00",
}

/** Black or white on a fill, as six-digit hex. */
const inkOn = (fill: string) => hex6(readableText(fill)) ?? NEUTRAL_CARD.ink

/** A card pill's print colours. */
export function pillLook(
  pill: CardPill,
  checks: CheckLook = {}
): Omit<DiagramPill, "text"> {
  if (pill.kind === "check") {
    const fill = printColor(
      checks[pill.status]?.color,
      CHECK_HEX[pill.status] ?? PRINT.subtle
    )
    return { kind: "monitor", fill, ink: inkOn(fill) }
  }
  const fill = printColor(pill.status.color, PRINT.faint)
  return { kind: "status", fill, ink: inkOn(fill) }
}

/** The tenant's monitoring names, as `cardContent` takes them. */
export function checkNames(
  checks: CheckLook = {}
): Partial<Record<"down" | "degraded", string>> {
  return {
    down: checks.down?.name ?? undefined,
    degraded: checks.degraded?.name ?? undefined,
  }
}

/** A path under this Danbyte, absolute when the origin is known. */
export function danbyteUrl(origin: string | undefined, path: string): string {
  return `${(origin ?? "").replace(/\/+$/, "")}${path}`
}

/**
 * A card as a document node: `box` from `cardLayout`, placed with its
 * centre at `c`. The text goes where the canvas put it (`place`); the pill
 * is laid out by the same rule, in the room the box kept for it.
 */
export function cardNode(
  id: string,
  c: Pt,
  box: CardBox,
  input: CardLayoutInput,
  opts: {
    pill?: CardPill | null
    checks?: CheckLook
    nubs?: readonly Nub[]
    link?: string
    measure?: Measure
  } = {}
): DiagramNode {
  const x = c.x - box.w / 2
  const y = c.y - box.h / 2
  const fill = box.fill ?? NEUTRAL_CARD.fill
  const ink = box.fill ? inkOn(box.fill) : NEUTRAL_CARD.ink
  let pill: DiagramPill | undefined
  let pillRect: Rect | undefined
  if (opts.pill) {
    // The same box with the pill in: `box.nubs` is the demand it was sized
    // for, and the pill's room was kept (`pillSlot`), so only the pill is
    // new.
    const laid = cardLayout(
      { ...input, pill: { kind: opts.pill.kind, text: opts.pill.text } },
      box.nubs,
      opts.measure
    ).pill
    if (laid) {
      pill = { ...pillLook(opts.pill, opts.checks), text: laid.text }
      pillRect = { ...laid.rect, x: x + laid.rect.x, y: y + laid.rect.y }
    }
  }
  const nubs: DiagramNub[] = (opts.nubs ?? []).map((n) => {
    const r = nubRect(box.w, box.h, n.side, n.off)
    return {
      x: x + r.x,
      y: y + r.y,
      w: r.w,
      h: r.h,
      side: DOC_SIDE[n.side],
      ...(n.port ? { label: n.port } : {}),
    }
  })
  return {
    id,
    kind: "card",
    x,
    y,
    w: box.w,
    h: box.h,
    fill,
    ink,
    title: box.title.text,
    lines: box.lines.map((l) => l.text),
    ...(pill ? { pill } : {}),
    ...(nubs.length ? { nubs } : {}),
    place: {
      title: { x: x + box.title.x, y: y + box.title.y },
      lines: box.lines.map((l) => ({ x: x + l.x, y: y + l.y })),
      ...(pillRect ? { pill: pillRect } : {}),
    },
    ...(opts.link ? { link: opts.link } : {}),
  }
}

/** A neutral card laid out for `input`, stretched to a fixed box with its
 * text kept centred. */
export function fitBox(
  input: CardLayoutInput,
  size: { w: number; h: number },
  measure?: Measure
): CardBox {
  const box = cardLayout({ ...input, color: null }, null, measure)
  const dx = (size.w - box.w) / 2
  return {
    ...box,
    w: size.w,
    h: Math.max(box.h, size.h),
    title: { ...box.title, x: box.title.x + dx },
    lines: box.lines.map((l) => ({ ...l, x: l.x + dx })),
  }
}

const rectAt = (c: Pt, s: { w: number; h: number }): Rect => ({
  x: c.x - s.w / 2,
  y: c.y - s.h / 2,
  w: s.w,
  h: s.h,
})

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The side an end leaves through: its anchor's side, else the side its
 * direction points out of. */
export function endSide(e: End, a?: Anchor): DocSide {
  if (a?.k === "side") return DOC_SIDE[a.side]
  const [dx, dy] = e.dir
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0
      ? "right"
      : "left"
    : dy >= 0
      ? "bottom"
      : "top"
}

/** The payload edge kind as the document's link kind. */
function docSem(sem: string | undefined, cables: number): LinkSem {
  if (sem === "ghost" || sem === "bgp") return sem
  if (sem === "lagbundle" || sem === "bundle") return "bundle"
  return cables > 1 ? "bundle" : "cable"
}

/** A link's print stroke from its canvas style. LLDP ghosts and BGP
 * sessions draw faded on screen; print pre-mixes that (no opacity). */
export function linkPaint(
  sem: LinkSem,
  style: CSSProperties | undefined
): Pick<DiagramLink, "stroke" | "width" | "dash"> {
  const base = LINK_DEFAULTS[sem]
  if (sem === "ghost" || sem === "bgp")
    return { stroke: base.stroke, width: base.width, dash: base.dash }
  const width = Number(style?.strokeWidth)
  const dash =
    typeof style?.strokeDasharray === "string" ? style.strokeDasharray : ""
  return {
    stroke: printColor(style?.stroke, base.stroke),
    width: Number.isFinite(width) && width > 0 ? width : base.width,
    ...(dash ? { dash } : {}),
  }
}

/** A route as a document link. */
export function routeLink(
  id: string,
  source: string,
  target: string,
  route: Pick<Route, "kind" | "pts">,
  ends: [DiagramEnd, DiagramEnd],
  rest: Omit<
    DiagramLink,
    "id" | "kind" | "source" | "target" | "points" | "labels"
  > & { labels?: DiagramLink["labels"] }
): DiagramLink {
  return {
    id,
    kind: route.kind,
    ...rest,
    source: { ...ends[0], node: source },
    target: { ...ends[1], node: target },
    points: route.pts.slice(1, -1).map((p) => ({ x: p.x, y: p.y })),
    labels: rest.labels ?? {},
  }
}

/** Zones and bands as document bands, back to front. */
export function regionBands(
  regions: readonly Region[],
  area?: Rect | null
): DiagramBand[] {
  return regions
    .filter((z) => !area || overlaps(area, z))
    .map((z) => ({
      id: `zone:${z.id}`,
      kind: z.kind === "band" ? (z.orient === "v" ? "column" : "row") : "zone",
      orient: z.kind === "band" && z.orient === "v" ? "v" : "h",
      label: z.label,
      x: z.x,
      y: z.y,
      w: z.w,
      h: z.h,
      fill: hex6(z.color),
    }))
}

/** Saved-view notes as document notes. */
export function viewNotes(
  notes: readonly TopologyViewNote[] = [],
  area?: Rect | null
): DiagramNote[] {
  return notes
    .filter(
      (n) =>
        (n.text || n.icon) &&
        (!area ||
          (n.x >= area.x &&
            n.x <= area.x + area.w &&
            n.y >= area.y &&
            n.y <= area.y + area.h))
    )
    .map((n) => ({
      id: `note:${n.id}`,
      x: n.x,
      y: n.y,
      ...(n.text ? { text: n.text } : {}),
      ...(n.icon ? { icon: n.icon } : {}),
    }))
}

/** The legend's entries as the exports draw them: print colours, the pill
 * in its print look, and only what a file can show (role fills, the pill,
 * line styles, colour-mode swatches). */
export function printLegend(
  items: readonly LegendItem[],
  checks: CheckLook = {}
): LegendRow[] {
  const out: LegendRow[] = []
  for (const it of items) {
    if (it.kind === "role") {
      const fill = hex6(it.color)
      out.push({
        kind: "role",
        label: it.label,
        fill: fill ?? NEUTRAL_CARD.fill,
        ink: fill ? inkOn(fill) : NEUTRAL_CARD.ink,
      })
    } else if (it.kind === "pill") {
      const look = pillLook({ kind: "check", status: "down", text: "" }, checks)
      out.push({
        kind: "pill",
        label: checks.down?.name || "Down",
        fill: look.fill,
        ink: look.ink,
      })
    } else if (it.kind === "line") {
      const base = it.sem ? LINK_DEFAULTS[it.sem] : LINK_DEFAULTS.cable
      const sem = it.sem === "ghost" || it.sem === "bgp"
      out.push({
        kind: "line",
        label: it.label,
        stroke: sem ? base.stroke : printColor(it.color, base.stroke),
        width: it.width ?? base.width,
        ...((it.dash ?? base.dash) ? { dash: it.dash ?? base.dash } : {}),
      })
    } else if (it.kind === "tone") {
      out.push({
        kind: "line",
        label: it.label,
        stroke: printColor(it.color, PRINT.subtle),
        width: 2.5,
      })
    }
  }
  return out
}

// ── The Diagram ──────────────────────────────────────────────────────────

type CardData = TopoNode["data"]

/** How many cables an edge stands for. */
function cableCount(d: DiagramEdgeData): number {
  if (d.cables?.length)
    return d.cables.reduce((n, c) => n + Math.max(1, c.pairs?.length ?? 0), 0)
  return Math.max(1, d.raw?.pairs?.length ?? 0)
}

/**
 * Simple: every cable between two devices is one line. A Detailed map
 * keeps a pair's separate cables apart, so its Simple document folds them
 * here - one line with a count chip, like the Simple canvas.
 */
function foldPairs(edges: LiveEdge[]): LiveEdge[] {
  const groups = new Map<string, LiveEdge[]>()
  const out: (LiveEdge | string)[] = []
  for (const e of edges) {
    const d = e.data as DiagramEdgeData | undefined
    const wiring =
      e.type === "link" &&
      (d?.sem === "cable" || d?.sem === "lagbundle" || d?.sem === "bundle")
    if (!wiring) {
      out.push(e)
      continue
    }
    const key = [e.source, e.target].sort().join("|")
    const g = groups.get(key)
    if (g) g.push(e)
    else {
      groups.set(key, [e])
      out.push(key)
    }
  }
  return out.map((x) => {
    if (typeof x !== "string") return x
    const g = groups.get(x)!
    if (g.length === 1) return g[0]
    const first = g[0]
    const d = first.data as DiagramEdgeData
    const n = g.reduce((s, e) => s + cableCount(e.data as DiagramEdgeData), 0)
    const strokes = new Set(g.map((e) => String(e.style?.stroke ?? "")))
    return {
      ...first,
      id: `${first.id}+${g.length - 1}`,
      style: {
        strokeWidth: 1.75,
        ...(strokes.size === 1 && first.style?.stroke
          ? { stroke: first.style.stroke }
          : {}),
      },
      data: {
        ...d,
        sem: "bundle",
        raw: undefined,
        cables: undefined,
        labels: { mid: [`${n}x`] },
      } satisfies DiagramEdgeData,
    }
  })
}

/** A link's way back into Danbyte: its cable, or its BGP session. */
function edgeUrl(
  d: DiagramEdgeData,
  origin: string | undefined
): string | undefined {
  if (d.sem === "cable" && d.raw?.cable_id)
    return danbyteUrl(origin, `/cables/${d.raw.cable_id}`)
  const session = d.bgp?.sessions?.[0]
  if (d.sem === "bgp" && session)
    return danbyteUrl(origin, `/bgp-sessions/${session}`)
  return undefined
}

/**
 * The Diagram as a document, from its model and the canvas's live nodes
 * (their centres) and edges (their anchors). Without `live.edges`, or for
 * the other mode, the links are re-anchored from the live centres the way
 * a drag does (`relinkDiagram`). `regions` are the Diagram's zones and
 * bands.
 */
export function toDocument(
  model: DiagramModel,
  live: { nodes: readonly LiveNode[]; edges?: readonly LiveEdge[] },
  regions: readonly Region[],
  opts: DocumentOptions
): DiagramDocument {
  const measure = opts.measure ?? model.measure
  const mode = opts.mode ?? model.mode
  const area = opts.area ?? null
  const shownNodes = live.nodes.filter(
    (n) => !n.hidden && (model.base.has(n.id) || model.fixed.has(n.id))
  )

  // Boxes, nubs and anchored edges for the document's mode.
  let shown = model.shown
  let edges: LiveEdge[]
  if (mode === model.mode && live.edges) {
    edges = live.edges.filter((e) => !e.hidden)
  } else {
    const re = relinkDiagram(
      mode === model.mode ? model : { ...model, mode, shown: new Map() },
      shownNodes.map((n) => ({ id: n.id, position: n.position, data: {} }))
    )
    shown = re.model.shown
    edges = re.edges.filter((e) => !e.hidden)
    if (mode === "simple" && model.mode === "detailed") edges = foldPairs(edges)
  }

  // The cards.
  const rects = new Map<string, Rect>()
  const nubIndex = new Map<string, number>()
  const nodes: DiagramNode[] = []
  for (const n of shownNodes) {
    const c = { x: n.position.x, y: n.position.y }
    const data = (n.data ?? {}) as CardData & {
      diagram?: { box: CardBox; nubs: Nub[] }
    }
    const input = model.cards.get(n.id)
    if (input) {
      const card = shown.get(n.id) ?? data.diagram
      if (!card) continue
      const r = rectAt(c, card.box)
      if (area && !overlaps(area, r)) continue
      const monitor = data.device_id
        ? opts.monitor?.[data.device_id]?.status
        : undefined
      const pill = cardContent(data, {
        monitor,
        checkLabels: checkNames(opts.checkLabels),
      }).pill
      const nubs = mode === "detailed" ? card.nubs : []
      nubs.forEach((u, i) => nubIndex.set(`${u.link}#${u.cable}${u.end}`, i))
      rects.set(n.id, r)
      nodes.push(
        cardNode(n.id, c, card.box, input, {
          pill,
          checks: opts.checkLabels,
          nubs,
          link: data.device_id
            ? danbyteUrl(opts.origin, `/devices/${data.device_id}`)
            : undefined,
          measure,
        })
      )
      continue
    }
    // A site or location card on a grouped map: a neutral card at the
    // group card's size, its name and device count at the top.
    const size = model.fixed.get(n.id)!
    const r = rectAt(c, size)
    if (area && !overlaps(area, r)) continue
    const group = data as { name?: string; device_count?: number }
    const count = group.device_count
    const groupCard: CardLayoutInput = {
      name: group.name ?? "",
      lines:
        count !== undefined
          ? [{ key: "count", text: `${count} device${count === 1 ? "" : "s"}` }]
          : [],
    }
    rects.set(n.id, r)
    nodes.push(
      cardNode(n.id, c, fitBox(groupCard, r, measure), groupCard, { measure })
    )
  }

  // The links: one per cable in Detailed (each leaves its own nub), one
  // per device pair in Simple.
  const links: DiagramLink[] = []
  for (const e of edges) {
    if (e.type !== "link" && e.type !== "overlay") continue
    const s = rects.get(e.source)
    const t = rects.get(e.target)
    const d = e.data as DiagramEdgeData | undefined
    if (!s || !t || !d) continue
    const overlay = e.type === "overlay"
    // A BGP session is an overlay, not wiring: it meets the facing side
    // midpoints, like any Simple line.
    const pairs = linkEnds(overlay ? { a: [], b: [], simple: true } : d, s, t)
    if (!pairs.length) continue
    const sem = docSem(d.sem, cableCount(d))
    const line = overlay || sem === "ghost" ? "straight" : d.line
    const wp = elbowChannel(d, s, t)
    const paint = linkPaint(sem, e.style)
    const detailed = !overlay && !d.simple && mode === "detailed"
    const mids = (d.labels.mid ?? []).filter(Boolean)
    const midAt = Math.floor(pairs.length / 2)
    const url = edgeUrl(d, opts.origin)
    pairs.forEach(([a, b], i) => {
      const route = linkRoute(line, a, b, { wp })
      const aa = detailed ? d.a[i] : undefined
      const ba = detailed ? d.b[i] : undefined
      const na = detailed ? nubIndex.get(`${e.id}#${i}a`) : undefined
      const nb = detailed ? nubIndex.get(`${e.id}#${i}b`) : undefined
      links.push(
        routeLink(
          i ? `${e.id}~${i}` : e.id,
          e.source,
          e.target,
          route,
          [
            {
              node: e.source,
              x: a.x,
              y: a.y,
              side: endSide(a, aa),
              ...(na !== undefined ? { nub: na } : {}),
            },
            {
              node: e.target,
              x: b.x,
              y: b.y,
              side: endSide(b, ba),
              ...(nb !== undefined ? { nub: nb } : {}),
            },
          ],
          {
            sem,
            ...paint,
            labels: {
              ...(i === midAt && mids.length ? { mid: mids } : {}),
              ...(aa?.port ? { a: { text: aa.port, rotate: true } } : {}),
              ...(ba?.port ? { b: { text: ba.port, rotate: true } } : {}),
            },
            ...(url ? { link: url } : {}),
          }
        )
      )
    })
  }

  const bands = regionBands(regions, area)
  const notes = viewNotes(opts.notes, area)
  const body = { bands, nodes, links, notes }
  return {
    meta: { ...opts.meta, mode },
    bounds: documentBounds(body, measure),
    ...body,
  }
}
