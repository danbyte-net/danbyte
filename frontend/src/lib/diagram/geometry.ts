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
    const p = along(poly, len / 2)
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
    const size = LABEL.END_SIZE
    const lh = size + 3
    const line: LabelLine = { text: label.text, weight: 400, italic: false }
    const tw = measure(label.text, size, 400)
    if (label.rotate) {
      // Along the line, starting just outside the nub. The direction of
      // travel away from the terminal decides the reading direction: text
      // always runs outward from the card and never upside down, and steep
      // runs (within 10° of vertical) read bottom to top.
      const p = along(poly, LABEL.PORT_DIST, fromEnd)
      let outward = p.angle >= -90 && p.angle < 90
      let rotate = outward
        ? p.angle
        : p.angle >= 90
          ? p.angle - 180
          : p.angle + 180
      if (rotate > 80) {
        rotate -= 180
        outward = !outward
      }
      const ty = p.y - LABEL.PORT_OFFSET
      const x0 = outward ? p.x : p.x - tw
      out.push({
        role,
        lines: [line],
        size,
        lh,
        anchor: outward ? "start" : "end",
        tx: p.x,
        ty,
        box: { x: x0 - 1.5, y: ty - size * 0.8, w: tw + 3, h: size + 1 },
        rotate,
        ox: p.x,
        oy: p.y,
        chip: false,
      })
    } else {
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
  doc: Pick<DiagramDocument, "bands" | "nodes" | "links" | "notes">,
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
  for (const n of doc.notes) addRect(noteLayout(n, measure).box)
  if (x0 > x1) return { x: 0, y: 0, w: 0, h: 0 }
  const [fx, fy] = [Math.floor(x0), Math.floor(y0)]
  return { x: fx, y: fy, w: Math.ceil(x1) - fx, h: Math.ceil(y1) - fy }
}
