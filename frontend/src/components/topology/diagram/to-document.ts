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
import type { PortPlace } from "@/lib/diagram/geometry"
import { baselineAt, fit, measureText } from "@/lib/diagram/measure"
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
  DiagramEndLabel,
  DiagramJunction,
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
import { leadStart, linkEnds } from "./anchors"
import type { AnchorLink, Nub } from "./anchors"
import { BAND, chipWidth, paintOrder, stackedSubRows, titleSpot } from "./bands"
import type { ArrangeCard } from "./bands"
import { distinctCables, relinkDiagram } from "./build-diagram"
import type { DiagramModel, PhotoModel } from "./build-diagram"
import { cardContent } from "./card-fields"
import type { CardPill } from "./card-fields"
import {
  CARD,
  cardLayout,
  JUNCTION,
  normalizeHex,
  NUB,
  nubRect,
  PILL,
  pillWidth,
} from "./card-layout"
import type { CardBox, CardLayoutInput } from "./card-layout"
import { leaves, linkRoute, planOf, routeThrough } from "./link-geometry"
import { captionPill, PHOTO } from "./photo-anchors"
import type { PhotoShown } from "./photo-anchors"
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
  "id" | "label" | "x" | "y" | "w" | "h" | "kind" | "orient" | "rule" | "layout"
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

/**
 * A photo node as a document node, centred at `c`: the image with the
 * markers its lines land on, the stub leads as nubs on the image edge, and
 * the caption (and pill) where the canvas put them. A photo taking its
 * cables at its edge has its Detailed nubs (`nubs`) on the image's sides
 * instead, after any stub leads. A faceplate node - it has no image to
 * export - is a card of the same box, its name at the top.
 */
export function photoDocNode(
  id: string,
  c: Pt,
  p: PhotoModel,
  shown: PhotoShown,
  color: string | null | undefined,
  opts: {
    pill?: CardPill | null
    checks?: CheckLook
    link?: string
    measure?: Measure
    nubs?: readonly Nub[]
  } = {}
): DiagramNode {
  const { w, h, imgH } = p.face
  const x = c.x - w / 2
  const y = c.y - h / 2
  const hex = normalizeHex(color)
  const fill = hex ?? NEUTRAL_CARD.fill
  const ink = hex ? inkOn(hex) : NEUTRAL_CARD.ink
  const photo = shown.kind === "photo" && !!shown.url
  const nubs: DiagramNub[] = shown.stubs.map((s) => ({
    x: x + s.x - NUB.ALONG / 2,
    y: s.side === "T" ? y - NUB.OUT : photo ? y + imgH : y + h,
    w: NUB.ALONG,
    h: NUB.OUT,
    side: s.side === "T" ? "top" : "bottom",
    ...(s.port ? { label: s.port } : {}),
  }))
  for (const n of opts.nubs ?? []) {
    // On the image's sides; drawn as a card, the bottom ones on its edge.
    const r = nubRect(w, n.side === "B" && !photo ? h : imgH, n.side, n.off)
    nubs.push({
      x: x + r.x,
      y: y + r.y,
      w: r.w,
      h: r.h,
      side: DOC_SIDE[n.side],
      ...(n.port ? { label: n.port } : {}),
    })
  }
  const common = {
    id,
    x,
    y,
    w,
    h,
    fill,
    ink,
    lines: [],
    ...(nubs.length ? { nubs } : {}),
    ...(opts.link ? { link: opts.link } : {}),
  }
  let pill: DiagramPill | undefined
  let pillRect: Rect | undefined
  if (opts.pill) {
    const text = fit(
      opts.pill.text,
      PILL.MAX_W - 2 * PILL.PAD_X,
      PILL.SIZE,
      PILL.WEIGHT,
      opts.measure ?? measureText
    )
    pill = { ...pillLook(opts.pill, opts.checks), text }
    const r = captionPill(shown.caption, pillWidth(text, opts.measure))
    pillRect = { ...r, x: x + r.x, y: y + r.y }
  }
  if (!photo)
    return { ...common, kind: "card", title: p.name, ...(pill ? { pill } : {}) }
  const cap = shown.caption
  return {
    ...common,
    kind: "photo",
    title: cap.text,
    ...(pill ? { pill } : {}),
    photo: {
      href: shown.url!,
      x,
      y,
      w,
      h: imgH,
      markers: shown.marks.map((m) => ({
        port: m.port,
        x: x + (m.x - m.w / 2) * w,
        y: y + (m.y - m.h / 2) * imgH,
        w: m.w * w,
        h: m.h * imgH,
      })),
    },
    place: {
      title: {
        x: x + cap.x + cap.w / 2,
        y: y + baselineAt(cap.top, CARD.TITLE_SIZE, PHOTO.CAPTION_LH),
      },
      lines: [],
      ...(pillRect ? { pill: pillRect } : {}),
    },
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

/** Zones and bands as document bands, back to front: side bands, then
 * rows, then zones, as the canvas stacks them. A row's title goes where
 * the canvas puts it (`titleSpot`): clear of the spans `titles` holds for
 * its strip. A stacked row of several layers carries its sub-rows, read
 * off `cards` (the cards drawn, with their roles and types) as the canvas
 * reads them. */
export function regionBands(
  regions: readonly Region[],
  area?: Rect | null,
  titles?: ReadonlyMap<string, readonly (readonly [number, number])[]>,
  measure: Measure = measureText,
  cards: readonly ArrangeCard[] = []
): DiagramBand[] {
  const subs = stackedSubRows(
    regions.map((z) => ({ ...z, color: z.color ?? null })),
    cards
  )
  return paintOrder(regions)
    .filter((z) => !area || overlaps(area, z))
    .map((z) => {
      const kind =
        z.kind === "band" ? (z.orient === "v" ? "column" : "row") : "zone"
      const busy = kind === "row" ? titles?.get(z.id) : undefined
      const text = busy
        ? measure(
            fit(z.label, Math.max(0, z.w - 32), BAND.CHIP_SIZE, 600, measure),
            BAND.CHIP_SIZE,
            600
          )
        : 0
      const titleX = busy
        ? Math.round(titleSpot(z, chipWidth(text, z.w), busy))
        : undefined
      const layers = subs.get(z.id)
      return {
        id: `zone:${z.id}`,
        kind,
        orient: z.kind === "band" && z.orient === "v" ? "v" : "h",
        label: z.label,
        x: z.x,
        y: z.y,
        w: z.w,
        h: z.h,
        fill: hex6(z.color),
        ...(titleX !== undefined && titleX !== Math.round(z.x + z.w / 2)
          ? { titleX }
          : {}),
        ...(layers?.length
          ? {
              layers: layers.map((s) => ({
                label: s.label,
                ...(s.color ? { fill: hex6(s.color) } : {}),
                y: s.y,
                h: s.h,
              })),
            }
          : {}),
      }
    })
}

/** Saved-view notes as document notes. A note is in an area when its
 * centre is. */
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
      ...(n.size && n.size !== "m" ? { size: n.size } : {}),
      ...(n.outline ? { outline: true } : {}),
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
        caption: it.label,
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

/** The cables an edge stands for, by id: a bundle's members, a breakout
 * part's cable, or its own. */
function cableIds(d: DiagramEdgeData): string[] {
  if (d.cables?.length) return d.cables.map((c, i) => c.cable_id ?? `#${i}`)
  const id = d.cableId ?? d.raw?.cable_id
  return id ? [id] : []
}

/** How many distinct cables an edge stands for: a breakout cable's port
 * pairs are one cable. */
function cableCount(d: DiagramEdgeData): number {
  if (d.cables?.length) return distinctCables(d.cables)
  return 1
}

const isWiring = (e: Pick<Edge, "type"> & { data?: unknown }) => {
  const d = e.data as DiagramEdgeData | undefined
  return (
    e.type === "link" &&
    (d?.sem === "cable" || d?.sem === "lagbundle" || d?.sem === "bundle")
  )
}

/**
 * Simple: every cable between two devices is one line. A Detailed map
 * keeps a pair's separate cables apart, so its Simple document folds them
 * here - one line with a count chip, like the Simple canvas - and a
 * breakout's legs to one card into one leg. Each folded edge comes with
 * the id of the edge it was made from. Lines to a photo stay apart
 * (`keep`): each lands on its own port.
 */
function foldPairs<TEdge extends LiveEdge>(
  edges: readonly TEdge[],
  keep?: (e: TEdge) => boolean
): [TEdge, string][] {
  const groups = new Map<string, TEdge[]>()
  const out: (TEdge | string)[] = []
  for (const e of edges) {
    if (!isWiring(e) || keep?.(e)) {
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
  return out.map((x): [TEdge, string] => {
    if (typeof x !== "string") return [x, x.id]
    const g = groups.get(x)!
    if (g.length === 1) return [g[0], g[0].id]
    const first = g[0]
    const d = first.data as DiagramEdgeData
    const ids = new Set(g.flatMap((e) => cableIds(e.data as DiagramEdgeData)))
    const id = `${first.id}+${g.length - 1}`
    const { plan: _p, planAt: _a, ...rest } = d
    if (ids.size < 2)
      // One cable reaching the pair several ways (a breakout's legs).
      return [{ ...first, id, data: rest }, first.id]
    const strokes = new Set(g.map((e) => String(e.style?.stroke ?? "")))
    return [
      {
        ...first,
        id,
        style: {
          strokeWidth: 1.75,
          ...(strokes.size === 1 && first.style?.stroke
            ? { stroke: first.style.stroke }
            : {}),
        },
        data: {
          ...rest,
          sem: "bundle",
          raw: undefined,
          cables: undefined,
          cableId: undefined,
          fan: undefined,
          labels: { mid: [`${ids.size}x`] },
        } satisfies DiagramEdgeData,
      },
      first.id,
    ]
  })
}

/** A Detailed map's model as its Simple picture: each pair's cables
 * folded into one line before the lines are planned, so the lanes are
 * the Simple ones. */
function simpleModel(model: DiagramModel): DiagramModel {
  const byId = new Map(model.links.map((l) => [l.id, l]))
  // Lines to a photo's ports; a photo taking its cables at its edge folds
  // them like a card.
  const onPorts = (id: string) => {
    const p = model.photos?.get(id)
    return !!p && !p.face.edge
  }
  const photo = (e: { source: string; target: string }) =>
    onPorts(e.source) || onPorts(e.target)
  const folded = foldPairs(model.edges, photo)
  const links: AnchorLink[] = []
  for (const [e, from] of folded) {
    const l = byId.get(from)
    if (!l) continue
    links.push({
      id: e.id,
      source: e.source,
      target: e.target,
      simple: true,
      ...(l.junction ? { junction: l.junction } : {}),
      // A photo's lines keep their ports, to land on them.
      ...(photo(e) && l.cables ? { cables: l.cables } : {}),
    })
  }
  return {
    ...model,
    mode: "simple",
    shown: new Map(),
    edges: folded.map(([e]) => e),
    links,
  }
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
  const fanIds = new Set([
    ...model.fans.map((f) => f.id),
    ...(model.meshes ?? []).flatMap((m) => [m.id, m.idB]),
  ])

  // Boxes, nubs, junctions and anchored edges for the document's mode.
  let shown = model.shown
  let titles = model.titles
  let edges: LiveEdge[]
  const junctionAt = new Map<string, Pt>()
  if (mode === model.mode && live.edges) {
    edges = live.edges.filter((e) => !e.hidden)
    for (const n of live.nodes)
      if (!n.hidden && fanIds.has(n.id))
        junctionAt.set(n.id, { x: n.position.x, y: n.position.y })
  } else {
    const re = relinkDiagram(
      mode === model.mode
        ? model
        : mode === "simple"
          ? simpleModel(model)
          : { ...model, mode, shown: new Map() },
      shownNodes.map((n) => ({ id: n.id, position: n.position, data: {} }))
    )
    shown = re.model.shown
    titles = re.model.titles
    edges = re.edges.filter((e) => !e.hidden)
    for (const [id, c] of re.junctions) junctionAt.set(id, c)
  }

  // The cards.
  const rects = new Map<string, Rect>()
  const nubIndex = new Map<string, number>()
  const nodes: DiagramNode[] = []
  for (const n of shownNodes) {
    const c = { x: n.position.x, y: n.position.y }
    const data = (n.data ?? {}) as CardData & {
      diagram?: { box: CardBox; nubs: Nub[]; photo?: PhotoShown }
    }
    const photo = model.photos?.get(n.id)
    if (photo) {
      const drawn = shown.get(n.id)?.photo ?? data.diagram?.photo
      if (!drawn) continue
      const r = rectAt(c, photo.face)
      if (area && !overlaps(area, r)) continue
      const monitor = data.device_id
        ? opts.monitor?.[data.device_id]?.status
        : undefined
      rects.set(n.id, r)
      // Edge nubs, numbered after the stub leads.
      const edgeNubs =
        mode === "detailed" && photo.face.edge
          ? (shown.get(n.id)?.nubs ?? data.diagram?.nubs ?? [])
          : []
      edgeNubs.forEach((u, i) =>
        nubIndex.set(`${u.link}#${u.cable}${u.end}`, drawn.stubs.length + i)
      )
      nodes.push(
        photoDocNode(n.id, c, photo, drawn, data.role?.color, {
          nubs: edgeNubs,
          pill: cardContent(data, {
            monitor,
            checkLabels: checkNames(opts.checkLabels),
          }).pill,
          checks: opts.checkLabels,
          link: data.device_id
            ? danbyteUrl(opts.origin, `/devices/${data.device_id}`)
            : undefined,
          measure,
        })
      )
      continue
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

  // The devices drawn, as a stacked row sorts them onto its sub-rows.
  const layerCards: ArrangeCard[] = []
  for (const n of shownNodes) {
    const r = rects.get(n.id)
    const d = (n.data ?? {}) as Pick<
      TopoNode["data"],
      "device_id" | "role" | "device_type_id" | "device_type"
    >
    if (!r || !d.device_id) continue
    layerCards.push({
      id: n.id,
      box: r,
      role: d.role
        ? { id: d.role.id, name: d.role.name, color: d.role.color }
        : null,
      type: d.device_type_id
        ? { id: d.device_type_id, name: d.device_type }
        : null,
    })
  }

  // Breakout junctions: a dot in their cable's colour, where their trunk
  // meets their legs.
  const junctions: DiagramJunction[] = []
  for (const [id, c] of junctionAt) {
    if (
      area &&
      !(
        c.x >= area.x &&
        c.x <= area.x + area.w &&
        c.y >= area.y &&
        c.y <= area.y + area.h
      )
    )
      continue
    const trunk = edges.find(
      (e) => (e.data as DiagramEdgeData | undefined)?.fan?.junction === id
    )
    const d = trunk?.data as DiagramEdgeData | undefined
    rects.set(id, rectAt(c, JUNCTION))
    junctions.push({
      id,
      x: c.x,
      y: c.y,
      r: JUNCTION.w / 2,
      fill: linkPaint("cable", trunk?.style).stroke,
      ...(d?.cableId ? { cable: d.cableId } : {}),
      ...(d?.cableId
        ? { link: danbyteUrl(opts.origin, `/cables/${d.cableId}`) }
        : {}),
    })
  }

  // The links: one per cable in Detailed (each leaves its own nub), one
  // per device pair in Simple - each drawn as the canvas plans it.
  const docKind = new Map(nodes.map((n) => [n.id, n.kind]))
  const drawsPhoto = (id: string) => docKind.get(id) === "photo"
  const links: DiagramLink[] = []
  for (const e of edges) {
    if (e.type !== "link" && e.type !== "overlay") continue
    const s = rects.get(e.source)
    const t = rects.get(e.target)
    const d = e.data as DiagramEdgeData | undefined
    if (!s || !t || !d) continue
    const overlay = e.type === "overlay"
    const plan = overlay ? undefined : planOf(d, s, t)
    // A BGP session is an overlay, not wiring: it meets the facing side
    // midpoints, like any Simple line.
    const pairs = linkEnds(overlay ? { a: [], b: [], simple: true } : d, s, t)
    if (!pairs.length) continue
    const sem = docSem(d.sem, cableCount(d))
    const line = overlay || sem === "ghost" ? "straight" : d.line
    const paint = linkPaint(sem, e.style)
    const detailed = !overlay && !d.simple && mode === "detailed"
    const mids = (d.labels.mid ?? []).filter(Boolean)
    const midAt = Math.floor(pairs.length / 2)
    const url = edgeUrl(d, opts.origin)
    const cable = cableIds(d)
    pairs.forEach(([a0, b0], i) => {
      const p = plan?.[i]
      const aa = d.a[i] as Anchor | undefined
      const ba = d.b[i] as Anchor | undefined
      // A photo port's line starts at the port (its lead): the plan's
      // points already do, an unplanned line gets it here. A faceplate
      // exports as a card, so its lines start at its edge.
      const leadA = leadStart(s, aa)
      const leadB = leadStart(t, ba)
      const na = detailed ? nubIndex.get(`${e.id}#${i}a`) : undefined
      const nb = detailed ? nubIndex.get(`${e.id}#${i}b`) : undefined
      // On a photo's image: at a port, or on the image's edge off a nub.
      const onImage = (
        node: string,
        lead: Pt | null,
        anchor: Anchor | undefined,
        nub: number | undefined
      ) =>
        drawsPhoto(node) &&
        (!!lead || (anchor?.k === "side" && !!anchor.cap && nub === undefined))
      const imageA = onImage(e.source, leadA, aa, na)
      const imageB = onImage(e.target, leadB, ba, nb)
      const planned = p?.pts.slice(
        leadA && !imageA ? 1 : 0,
        leadB && !imageB ? -1 : undefined
      )
      const drawn = planned
        ? routeThrough(p!.line ?? line, planned, leaves(planned))
        : linkRoute(line, a0, b0)
      const route = {
        kind: drawn.kind,
        pts: planned
          ? drawn.pts
          : [
              ...(imageA && leadA ? [leadA] : []),
              ...drawn.pts,
              ...(imageB && leadB ? [leadB] : []),
            ],
      }
      const first = route.pts[0]
      const last = route.pts[route.pts.length - 1]
      const a = { ...a0, x: first.x, y: first.y }
      const b = { ...b0, x: last.x, y: last.y }
      // The end labels on the line: where the plan seated them, or (a
      // drag in progress) one after another from the end.
      const named = !d.labels.noPorts && (detailed || d.sem === "cable")
      const port = (
        anchor: typeof aa,
        placed: PortPlace | null | undefined
      ): DiagramEndLabel | undefined => {
        if (overlay || !anchor || placed === null) return undefined
        // A photo port is named in either mode, like a Detailed nub.
        const text =
          anchor.k === "point"
            ? !d.labels.noPorts && anchor.port
            : anchor.k === "side" && named && anchor.port
        if (!text) return undefined
        return { text, ...(placed ? { at: placed } : {}) }
      }
      const addresses = (
        anchor: typeof aa,
        lines: string[] | undefined,
        placed: PortPlace[] | null | undefined
      ): DiagramEndLabel[] | undefined => {
        if (overlay || !anchor || anchor.k === "junction" || !lines?.length)
          return undefined
        if (plan && !placed) return undefined
        return lines.map((text, k) => ({
          text,
          ...(placed?.[k] ? { at: placed[k] } : {}),
        }))
      }
      const la = port(aa, p ? p.a : undefined)
      const lb = port(ba, p ? p.b : undefined)
      const ends = d.labels.ends?.[i]
      const ia = addresses(aa, ends?.a, p?.ips?.a)
      const ib = addresses(ba, ends?.b, p?.ips?.b)
      const end = (
        node: string,
        at: End,
        anchor: typeof aa,
        nub: number | undefined,
        image: boolean
      ): DiagramEnd => ({
        node,
        x: at.x,
        y: at.y,
        ...(anchor?.k === "junction"
          ? {}
          : { side: endSide(at, detailed ? anchor : undefined) }),
        ...(nub !== undefined ? { nub } : {}),
        ...(image ? { marker: true } : {}),
      })
      links.push(
        routeLink(
          i ? `${e.id}~${i}` : e.id,
          e.source,
          e.target,
          route,
          [end(e.source, a, aa, na, imageA), end(e.target, b, ba, nb, imageB)],
          {
            sem,
            ...paint,
            labels: {
              // A chip with no free spot shows on hover only on the canvas;
              // the file shows the map at rest.
              ...(i === midAt && mids.length && !(plan && d.crowded)
                ? {
                    mid: mids,
                    ...(plan && d.midT !== undefined ? { midAt: d.midT } : {}),
                    ...(plan && d.midOff ? { midOff: d.midOff } : {}),
                  }
                : {}),
              ...(la ? { a: la } : {}),
              ...(lb ? { b: lb } : {}),
              ...(ia ? { aIps: ia } : {}),
              ...(ib ? { bIps: ib } : {}),
            },
            ...(url ? { link: url } : {}),
            ...(cable.length === 1 ? { cable: cable[0] } : {}),
          }
        )
      )
    })
  }

  const bands = regionBands(regions, area, titles, measure, layerCards)
  const notes = viewNotes(opts.notes, area)
  const body = {
    bands,
    nodes,
    links,
    ...(junctions.length ? { junctions } : {}),
    notes,
  }
  return {
    meta: { ...opts.meta, mode },
    bounds: documentBounds(body, measure),
    ...body,
  }
}
