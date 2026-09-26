import { baselineAt, fit, measureText } from "./measure"
import type { Measure, Weight } from "./measure"
import { CARD, ELBOW_RADIUS, LABEL, PILL } from "./theme"
import type {
  DiagramDocument,
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

/** A link label, resolved: a halo box and baselines in its own frame,
 * turned by `rotate` degrees about `(ox, oy)`. */
export interface LabelBlock {
  role: "mid" | "a" | "b"
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
  /** Middle labels are chips with a hairline edge; end labels are plain. */
  chip: boolean
}

/** A Detailed port name's box height: the 9px text and a hairline. */
export const PORT_H = LABEL.END_SIZE + 1

/** Where a port name sits along its cable: the centre of its box and its
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

/**
 * A port name `w` px wide laid along the run leaving `start` at `angle`
 * degrees (the direction of travel away from the card): `out` px out,
 * beside the line on `side` (+1 = the right hand of travel, -1 = the left)
 * with `LABEL.PORT_OFFSET` px clear of it. The canvas, the SVG and the
 * draw.io file all place port names through this one rule.
 */
export function portPlace(
  start: Pt,
  angle: number,
  w: number,
  side: 1 | -1,
  out: number = LABEL.PORT_DIST
): PortPlace {
  const r = (angle * Math.PI) / 180
  const [ux, uy] = [Math.cos(r), Math.sin(r)]
  const d = out + w / 2
  const o = side * (LABEL.PORT_OFFSET + PORT_H / 2)
  return {
    x: start.x + ux * d - uy * o,
    y: start.y + uy * d + ux * o,
    rotate: uprightAngle(angle),
  }
}

/** The side of the line a port name goes on by default: outside the
 * cable's first bend (`next` is the direction after it), so the cable
 * turns away from the text; on a run with no bend, above the text as it
 * reads. */
export function portSide(u: Pt, next?: Pt | null): 1 | -1 {
  if (next) {
    const cross = u.x * next.y - u.y * next.x
    if (Math.abs(cross) > 1e-9) return cross > 0 ? -1 : 1
  }
  // Above the reading line: against the text frame's down vector.
  const r =
    (uprightAngle((Math.atan2(u.y, u.x) * 180) / Math.PI) * Math.PI) / 180
  const down = { x: -Math.sin(r), y: Math.cos(r) }
  const n = { x: -u.y, y: u.x }
  return n.x * down.x + n.y * down.y > 0 ? -1 : 1
}

/** A port name's label block, centred on its place and turned about it. */
export function portBlock(
  role: "a" | "b",
  text: string,
  tw: number,
  place: PortPlace
): LabelBlock {
  const size = LABEL.END_SIZE
  const w = tw + 3
  return {
    role,
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

/** A port name placed from the route alone (a polyline or a curve's
 * control points): just past the terminal,
 * outside the first bend. */
export function routePortPlace(
  poly: Pt[],
  fromEnd: boolean,
  tw: number
): PortPlace {
  const pts = fromEnd ? [...poly].reverse() : poly
  const p = along(pts, 0)
  const r = (p.angle * Math.PI) / 180
  const u = { x: Math.cos(r), y: Math.sin(r) }
  let next: Pt | null = null
  for (let i = 1; i < pts.length - 1 && !next; i++) {
    const v = { x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y }
    const len = Math.hypot(v.x, v.y)
    if (len > 1e-6 && Math.abs(u.x * v.y - u.y * v.x) / len > 1e-3)
      next = { x: v.x / len, y: v.y / len }
  }
  return portPlace(pts[0], p.angle, tw, portSide(u, next))
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
      weight: link.sem === "bundle" && i === 0 ? 600 : 400,
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

  for (const role of ["a", "b"] as const) {
    const label = link.labels[role]
    if (!label?.text) continue
    const fromEnd = role === "b"
    const tw = measure(label.text, LABEL.END_SIZE, 400)
    if (label.rotate) {
      // Along the cable, beside its first straight run: where the builder
      // placed it, or by the same rule from the route alone.
      const place = label.at ?? routePortPlace(poly, fromEnd, tw)
      out.push(portBlock(role, label.text, tw, place))
      continue
    }
    const size = LABEL.END_SIZE
    const lh = size + 3
    const line: LabelLine = { text: label.text, weight: 400, italic: false }
    const p = along(poly, Math.min(LABEL.END_DIST, 0.35 * len), fromEnd)
    const w = tw + 2 * LABEL.PAD_X
    const box = { x: p.x - w / 2, y: p.y - lh / 2, w, h: lh }
    out.push({
      role,
      lines: [line],
      size,
      lh,
      anchor: "middle",
      tx: p.x,
      ty: baselineAt(box.y, size, lh),
      box,
      rotate: 0,
      ox: p.x,
      oy: p.y,
      chip: false,
    })
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
