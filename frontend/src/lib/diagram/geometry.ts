import { baselineAt, fit, measureText } from "./measure"
import type { Measure, Weight } from "./measure"
import { CARD, ELBOW_RADIUS, LABEL, PILL } from "./theme"
import type {
  DiagramDocument,
  DiagramEndLabel,
  DiagramLink,
  DiagramNode,
  DiagramNote,
  Pt,
  Rect,
} from "./types"

// Geometry the writers share: link paths by the same rules the canvas and
// draw.io use, where labels go along a route, how text sits on a card, and
// the document's bounds. Pure - numbers in, numbers out.

/** A number for the markup: 0.01 px, never `-0`, never `NaN`. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? "0" : String(r)
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const at = (p: Pt) => `${fmt(p.x)},${fmt(p.y)}`

/** Source terminal, interior points, target terminal. */
export function routePoints(
  link: Pick<DiagramLink, "source" | "target" | "points">
): Pt[] {
  return [link.source, ...link.points, link.target].map((p) => ({
    x: p.x,
    y: p.y,
  }))
}

/** A plain polyline. */
export function polylinePath(pts: Pt[]): string {
  if (pts.length < 2) return ""
  return (
    `M ${at(pts[0])}` +
    pts
      .slice(1)
      .map((p) => ` L ${at(p)}`)
      .join("")
  )
}

/** A polyline with each corner rounded by a quadratic of radius `r`, cut
 * short on segments shorter than 2r - the elbow rule. */
export function roundedPath(pts: Pt[], r: number = ELBOW_RADIUS): string {
  if (pts.length < 2) return ""
  let d = `M ${at(pts[0])}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const inLen = dist(prev, cur) || 1
    const outLen = dist(cur, next) || 1
    const dIn = Math.min(r, dist(prev, cur) / 2)
    const dOut = Math.min(r, dist(cur, next) / 2)
    const p1 = {
      x: cur.x - ((cur.x - prev.x) / inLen) * dIn,
      y: cur.y - ((cur.y - prev.y) / inLen) * dIn,
    }
    const p2 = {
      x: cur.x + ((next.x - cur.x) / outLen) * dOut,
      y: cur.y + ((next.y - cur.y) / outLen) * dOut,
    }
    d += ` L ${at(p1)} Q ${at(cur)} ${at(p2)}`
  }
  return d + ` L ${at(pts[pts.length - 1])}`
}

/** mxGraph's curved rule (`mxConnector.paintCurvedLine`, draw.io
 * `curved=1`): `M S`, then `Q Pi mid(Pi, Pi+1)` for each interior point but
 * the last, then `Q Pn T`. The curve passes through the midpoints of
 * consecutive control points - a cyclical arc through its apex. */
export function curvedPath(pts: Pt[]): string {
  const n = pts.length
  if (n < 2) return ""
  if (n === 2) return polylinePath(pts)
  let d = `M ${at(pts[0])}`
  for (let i = 1; i < n - 2; i++)
    d += ` Q ${at(pts[i])} ${at(mid(pts[i], pts[i + 1]))}`
  return d + ` Q ${at(pts[n - 2])} ${at(pts[n - 1])}`
}

/** The SVG path of a link. */
export function linkPath(
  link: Pick<DiagramLink, "kind" | "source" | "target" | "points">
): string {
  const pts = routePoints(link)
  switch (link.kind) {
    case "elbow":
      return roundedPath(pts)
    case "bendy":
    case "cyclical":
      return curvedPath(pts)
    default:
      return polylinePath(pts)
  }
}

function quad(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  }
}

const CURVE_STEPS = 16

/** The route as a polyline: curves sampled, elbow corners kept sharp (the
 * rounding moves a point by less than the radius). For lengths, label
 * placement and bounds. */
export function routePolyline(
  link: Pick<DiagramLink, "kind" | "source" | "target" | "points">
): Pt[] {
  const pts = routePoints(link)
  const n = pts.length
  if ((link.kind !== "bendy" && link.kind !== "cyclical") || n < 3) return pts
  const out: Pt[] = [pts[0]]
  let start = pts[0]
  for (let i = 1; i <= n - 2; i++) {
    const end = i < n - 2 ? mid(pts[i], pts[i + 1]) : pts[n - 1]
    for (let s = 1; s <= CURVE_STEPS; s++)
      out.push(quad(start, pts[i], end, s / CURVE_STEPS))
    start = end
  }
  return out
}

export function polylineLength(poly: Pt[]): number {
  let len = 0
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1], poly[i])
  return len
}

/** The point `d` px along a polyline from its start (or its end), with the
 * direction of travel away from that end, in degrees. */
export function along(
  poly: Pt[],
  d: number,
  fromEnd = false
): Pt & { angle: number } {
  const pts = fromEnd ? [...poly].reverse() : poly
  if (pts.length < 2) return { ...(pts[0] ?? { x: 0, y: 0 }), angle: 0 }
  let left = Math.max(0, d)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const seg = dist(a, b)
    if (seg === 0) continue
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
    if (left <= seg || i === pts.length - 1) {
      const t = Math.min(1, left / seg)
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle }
    }
    left -= seg
  }
  return { ...pts[pts.length - 1], angle: 0 }
}

// ── Labels ───────────────────────────────────────────────────────────────

export interface LabelLine {
  text: string
  weight: Weight
  italic: boolean
}

/** A link label, resolved: its box and baselines in its own frame,
 * turned by `rotate` degrees about `(ox, oy)`. */
export interface LabelBlock {
  /** The middle chip, a port name at the source (`a`) or target (`b`)
   * end, or one of that end's addresses (`ipa`, `ipb`, numbered by
   * `index`). */
  role: "mid" | "a" | "b" | "ipa" | "ipb"
  index?: number
  lines: LabelLine[]
  size: number
  lh: number
  anchor: "start" | "middle" | "end"
  /** Text x and first baseline. */
  tx: number
  ty: number
  box: Rect
  rotate: number
  ox: number
  oy: number
  /** Middle labels are chips with a hairline edge. End labels sit on
   * their line: the box is the gap the line breaks for, in the page's
   * colour, with no edge. */
  chip: boolean
}

/** An end label's height: the 9px text and a hairline. The line breaks
 * for a box this tall. */
export const PORT_H = LABEL.END_SIZE + 1

/** Where an end label sits: the centre of its text, on its line, and its
 * turn in degrees (`uprightAngle`). */
export interface PortPlace {
  x: number
  y: number
  rotate: number
}

/** A direction in degrees turned to read upright: [-100, 80). A run within
 * 10° of vertical, either way, reads bottom to top - on the canvas, in the
 * SVG and in draw.io alike. */
export function uprightAngle(angle: number): number {
  const r = ((((angle + 100) % 360) + 360) % 360) - 100
  return r >= 80 ? r - 180 : r
}

/** An end label's text width: exact (unhinted), as the canvas draws it
 * (`text-rendering: geometricPrecision`) and the exports set it, so the
 * gap cut for it is even on both sides at every zoom. */
export function endTextWidth(
  text: string,
  measure: Measure = measureText
): number {
  return measure(text, LABEL.END_SIZE, 400, true)
}

/** How much of its line an end label `w` px wide takes: the text, and the
 * gap on either side of it. */
export function inlineSpan(w: number): number {
  return w + 2 * LABEL.GAP
}

/**
 * An end label `w` px wide ON the straight run leaving `start` at `angle`
 * degrees (the direction of travel away from the card): the line runs
 * `out` px, breaks for the gap, the text and the gap, and runs on. The
 * text is centred on the line and turned to read upright. The canvas, the
 * SVG and the draw.io file all place end labels by this one rule.
 */
export function inlinePlace(
  start: Pt,
  angle: number,
  w: number,
  out: number = LABEL.LEAD
): PortPlace {
  const r = (angle * Math.PI) / 180
  const d = out + inlineSpan(w) / 2
  return {
    x: start.x + Math.cos(r) * d,
    y: start.y + Math.sin(r) * d,
    rotate: uprightAngle(angle),
  }
}

/**
 * End labels one after another along a route from one of its ends, from
 * where they sit alone (the route walked: the point `d` px out and the
 * direction of travel there): the first `LABEL.LEAD` px out, each next
 * `LABEL.LEAD` past the one before, each turned with the route where it
 * sits. `ws` are the texts' widths, nearest the end first.
 */
export function inlinePlaces(
  walk: (d: number) => Pt & { angle: number },
  ws: readonly number[]
): PortPlace[] {
  let d = LABEL.LEAD
  return ws.map((w) => {
    const span = inlineSpan(w)
    const c = walk(d + span / 2)
    d += span + LABEL.LEAD
    return { x: c.x, y: c.y, rotate: uprightAngle(c.angle) }
  })
}

/** An end label's block: the text centred on its place, over a box of the
 * page's colour - the gap its line breaks for. */
export function inlineBlock(
  role: "a" | "b" | "ipa" | "ipb",
  text: string,
  tw: number,
  place: PortPlace,
  index?: number
): LabelBlock {
  const size = LABEL.END_SIZE
  const w = inlineSpan(tw)
  return {
    role,
    ...(index !== undefined ? { index } : {}),
    lines: [{ text, weight: 400, italic: false }],
    size,
    lh: PORT_H,
    anchor: "middle",
    tx: place.x,
    ty: baselineAt(place.y - PORT_H / 2, size, PORT_H),
    box: { x: place.x - w / 2, y: place.y - PORT_H / 2, w, h: PORT_H },
    rotate: place.rotate,
    ox: place.x,
    oy: place.y,
    chip: false,
  }
}

/** Where a link's labels go. */
export function linkLabels(
  link: DiagramLink,
  measure: Measure = measureText
): LabelBlock[] {
  const poly = routePolyline(link)
  const len = polylineLength(poly)
  const out: LabelBlock[] = []

  const mids = (link.labels.mid ?? []).filter((s) => s)
  if (mids.length) {
    const size = LABEL.MID_SIZE
    const lh = LABEL.MID_LH
    const lines = mids.map<LabelLine>((text, i) => ({
      text,
      // A bundle's count ("2x", "Po1 ⇄ Po10 · 2x") stands out; its
      // subnets do not.
      weight:
        link.sem === "bundle" && i === 0 && /^\d+x\b|\b\d+x$/.test(text)
          ? 600
          : 400,
      italic: link.sem === "ghost",
    }))
    const w =
      Math.max(...lines.map((l) => measure(l.text, size, l.weight))) +
      2 * LABEL.PAD_X
    const h = lines.length * lh + 3
    const on = along(poly, len * (link.labels.midAt ?? 0.5))
    const off = link.labels.midOff ?? 0
    const r = (on.angle * Math.PI) / 180
    const p = off
      ? { x: on.x - Math.sin(r) * off, y: on.y + Math.cos(r) * off }
      : on
    const box = { x: p.x - w / 2, y: p.y - h / 2, w, h }
    out.push({
      role: "mid",
      lines,
      size,
      lh,
      anchor: "middle",
      tx: p.x,
      ty: baselineAt(box.y + 1.5, size, lh),
      box,
      rotate: 0,
      ox: p.x,
      oy: p.y,
      chip: true,
    })
  }

  // Each end's port name, then its addresses, on the line: where the
  // builder placed them clear of other cables and labels, or one after
  // another from the end by the same rule.
  for (const end of ["a", "b"] as const) {
    const port = link.labels[end]
    const ips = (end === "a" ? link.labels.aIps : link.labels.bIps) ?? []
    const pieces: {
      role: "a" | "b" | "ipa" | "ipb"
      label: DiagramEndLabel
      index?: number
    }[] = [
      ...(port?.text ? [{ role: end, label: port }] : []),
      ...ips.flatMap((label, index) =>
        label.text
          ? [
              {
                role: end === "a" ? ("ipa" as const) : ("ipb" as const),
                label,
                index,
              },
            ]
          : []
      ),
    ]
    if (!pieces.length) continue
    const ws = pieces.map((p) => endTextWidth(p.label.text, measure))
    const auto = pieces.some((p) => !p.label.at)
      ? inlinePlaces((d) => along(poly, d, end === "b"), ws)
      : []
    pieces.forEach((p, i) =>
      out.push(
        inlineBlock(p.role, p.label.text, ws[i], p.label.at ?? auto[i], p.index)
      )
    )
  }
  return out
}

/** A label's box corners after its rotation. */
export function labelCorners(b: LabelBlock): Pt[] {
  const { x, y, w, h } = b.box
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
  if (!b.rotate) return corners
  const r = (b.rotate * Math.PI) / 180
  const [c, s] = [Math.cos(r), Math.sin(r)]
  return corners.map((p) => ({
    x: b.ox + (p.x - b.ox) * c - (p.y - b.oy) * s,
    y: b.oy + (p.x - b.ox) * s + (p.y - b.oy) * c,
  }))
}

// ── Cards ────────────────────────────────────────────────────────────────

export interface PlacedText {
  text: string
  x: number
  /** Baseline. */
  y: number
}

export interface CardText {
  pill?: Rect & { text: string }
  title: PlacedText
  lines: PlacedText[]
}

/** A pill's width for `text`, as the canvas card sizes it. */
export function pillWidth(text: string, measure: Measure = measureText) {
  return Math.min(
    PILL.MAX_W,
    Math.ceil(measure(text, PILL.SIZE, PILL.WEIGHT)) + 2 * PILL.PAD_X
  )
}

/** Where a node's pill, name and lines go: the builder's `place` when it
 * sent one, else the card rule in theme.ts `CARD` (strings cut to fit). A
 * photo node puts its pill on the image's corner and its name and lines
 * under the image. */
export function cardText(
  node: DiagramNode,
  measure: Measure = measureText
): CardText {
  const pillText = node.pill?.text
  const place = node.place
  if (place)
    return {
      pill:
        place.pill && pillText ? { ...place.pill, text: pillText } : undefined,
      title: { text: node.title, x: place.title.x, y: place.title.y },
      lines: node.lines.flatMap((text, i) =>
        place.lines[i]
          ? [{ text, x: place.lines[i].x, y: place.lines[i].y }]
          : []
      ),
    }

  const photo = node.kind === "photo" ? node.photo : undefined
  const cx = node.x + node.w / 2
  let pill: CardText["pill"]
  if (pillText) {
    const text = fit(
      pillText,
      PILL.MAX_W - 2 * PILL.PAD_X,
      PILL.SIZE,
      PILL.WEIGHT,
      measure
    )
    const host = photo ?? node
    pill = {
      x: host.x + PILL.X,
      y: host.y + CARD.PAD_Y + (CARD.TITLE_LH - PILL.H) / 2,
      w: pillWidth(text, measure),
      h: PILL.H,
      text,
    }
  }

  let top: number
  let inset: number = CARD.PAD_X
  if (photo) top = photo.y + photo.h + CARD.CAPTION_GAP
  else {
    // A name centred on the card clears the pill on the left and keeps the
    // same space on the right; when it cannot, the pill takes a row of its
    // own above it.
    const beside = pill
      ? Math.max(CARD.PAD_X, PILL.X + pill.w + PILL.GAP)
      : CARD.PAD_X
    const nameW = Math.ceil(
      measure(node.title, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT)
    )
    const stacked = !!pill && nameW + 2 * beside > node.w
    if (pill && stacked) pill.y = node.y + CARD.PAD_Y
    inset = stacked ? CARD.PAD_X : beside
    top = node.y + CARD.PAD_Y + (stacked ? PILL.H + PILL.ROW_GAP : 0)
  }

  const title = {
    text: fit(
      node.title,
      Math.max(0, node.w - 2 * inset),
      CARD.TITLE_SIZE,
      CARD.TITLE_WEIGHT,
      measure
    ),
    x: cx,
    y: baselineAt(top, CARD.TITLE_SIZE, CARD.TITLE_LH),
  }
  const linesTop = top + CARD.TITLE_LH + CARD.LINES_GAP
  const lines = node.lines.map((line, i) => ({
    text: fit(
      line,
      Math.max(0, node.w - 2 * CARD.PAD_X),
      CARD.LINE_SIZE,
      CARD.LINE_WEIGHT,
      measure
    ),
    x: cx,
    y: baselineAt(linesTop + i * CARD.LINE_LH, CARD.LINE_SIZE, CARD.LINE_LH),
  }))
  return { pill, title, lines }
}

// ── Notes ────────────────────────────────────────────────────────────────

export const NOTE = { ICON: 16, GAP: 4, SIZE: 12, LH: 16 } as const

/** A note's text lines with baselines, and its box. */
export function noteLayout(
  note: DiagramNote,
  measure: Measure = measureText
): { lines: PlacedText[]; box: Rect } {
  const tx = note.x + (note.icon ? NOTE.ICON + NOTE.GAP : 0)
  const texts = note.text ? note.text.split("\n") : []
  const lines = texts.map((text, i) => ({
    text,
    x: tx,
    y: baselineAt(note.y + i * NOTE.LH, NOTE.SIZE, NOTE.LH),
  }))
  const textW = Math.max(0, ...texts.map((t) => measure(t, NOTE.SIZE)))
  return {
    lines,
    box: {
      x: note.x,
      y: note.y,
      w: tx - note.x + textW,
      h: Math.max(note.icon ? NOTE.ICON : 0, lines.length * NOTE.LH),
    },
  }
}

// ── Bounds ───────────────────────────────────────────────────────────────

/** The tight box around everything a document draws: bands, cards with
 * their nubs, routes, labels and notes. Builders store it as `bounds`. */
export function documentBounds(
  doc: Pick<DiagramDocument, "bands" | "nodes" | "links" | "notes"> &
    Pick<Partial<DiagramDocument>, "junctions">,
  measure: Measure = measureText
): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const addRect = (r: Rect) => {
    add(r.x, r.y)
    add(r.x + r.w, r.y + r.h)
  }
  doc.bands.forEach(addRect)
  for (const n of doc.nodes) {
    addRect(n)
    n.nubs?.forEach(addRect)
    if (n.photo) addRect(n.photo)
  }
  for (const l of doc.links) {
    routePolyline(l).forEach((p) => add(p.x, p.y))
    for (const b of linkLabels(l, measure))
      labelCorners(b).forEach((p) => add(p.x, p.y))
  }
  for (const j of doc.junctions ?? [])
    addRect({ x: j.x - j.r, y: j.y - j.r, w: 2 * j.r, h: 2 * j.r })
  for (const n of doc.notes) addRect(noteLayout(n, measure).box)
  if (x0 > x1) return { x: 0, y: 0, w: 0, h: 0 }
  const [fx, fy] = [Math.floor(x0), Math.floor(y0)]
  return { x: fx, y: fy, w: Math.ceil(x1) - fx, h: Math.ceil(y1) - fy }
}
