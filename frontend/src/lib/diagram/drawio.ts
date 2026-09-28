import { htmlEscape, xmlEscape } from "@/lib/xml"

import {
  cardText,
  documentBounds,
  fmt,
  linkLabels,
  noteLayout,
  NOTE,
} from "./geometry"
import type { LabelBlock } from "./geometry"
import { baselineAt, measureText } from "./measure"
import type { Measure } from "./measure"
import { toSvg } from "./svg"
import type { SvgOptions } from "./svg"
import {
  BAND,
  bandPaint,
  CARD,
  ELBOW_RADIUS,
  groundAt,
  hex6,
  mix,
  NUB,
  PILL,
  PRINT,
} from "./theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramEnd,
  DiagramJunction,
  DiagramLink,
  DiagramNode,
  DiagramNote,
  Pt,
  Rect,
  Side,
} from "./types"

// The draw.io writer: a DiagramDocument as an editable .drawio file - one
// uncompressed <mxfile> with a <diagram> per page, so the output is readable,
// diff-able and deterministic.
//
// - Cards are rounded rectangles filled with the role colour: the name bold
//   and the card lines under it in one HTML label, the pill a small child
//   cell in the top-left corner. Each card is an <object> carrying its
//   Danbyte id and a `link` back, so a click in draw.io opens the device.
// - Simple (the default): each line attaches to its card's side where the
//   document ends it - a Simple document ends them at the side midpoints.
//   Detailed: the nubs are child cells and each line attaches to its own.
// - Lines keep the screen's geometry. Ends are fixed points (`exitX/exitY`,
//   perimeter off). Elbows go through draw.io's orthogonal router with every
//   corner as a waypoint, which it reproduces exactly and keeps orthogonal
//   when a card moves. Bendy and cyclical lines are `curved=1` through the
//   same control points - draw.io's curved rule is the one the screen uses.
// - The middle label is the line's own label; end labels (port names,
//   then addresses) are child label cells at x = 2t-1 along the line, with
//   an offset that lands them where the screen puts them: on the line,
//   turned along it, over the page's colour so the line breaks for them.
// - A breakout cable's junction is a small ellipse its trunk ends on and
//   its legs leave from; trunk, legs and junction all carry the cable's
//   id (`danbyte_cable`).
// - Lines are written before the cards on the page's layer, so they pass
//   under cards as on the screen.
// - Row bands are swimlanes holding the cards whose centre they contain,
//   their title centred across the top, and zones are containers too. Side
//   bands are background shapes with a turned label (a card has one
//   parent). LLDP neighbours and BGP sessions get layers of their own.
// - An end label's gap is the colour under it: the page, or its band.
// - Photo nodes are cards by default. With `photos`, a photo inlined as a
//   `data:` URI is an image cell with its name as a label underneath, a
//   connection point on each marked port, and its cables attached at their
//   ports; it is written before the lines, so a cable's lead shows over it.
// - Text is Helvetica: Inter is rarely installed, and names cut to fit Inter,
//   which runs wider, still fit.

/** The draw.io file type, for downloads. */
export const DRAWIO_MIME = "application/vnd.jgraph.mxfile"

export type DrawioMode = "simple" | "detailed"

export interface DrawioOptions {
  /** `simple` (the default): cards only, lines attach to the card sides.
   * `detailed`: nubs become cells on the card edge and each line leaves
   * its own. */
  mode?: DrawioMode
  /** Where the drawing's top-left corner lands, px (40). */
  margin?: number
  /** Text widths for fitting names: `measureText` by default. */
  measure?: Measure
  /** Draw photo nodes as their photos (inlined `data:` images only; any
   * other is drawn as its card). Off by default: the card is the shape
   * draw.io users edit. */
  photos?: boolean
}

const FONT = "Helvetica"
const LAYER_LLDP = "layer-lldp"
const LAYER_BGP = "layer-bgp"

// ── Markup ───────────────────────────────────────────────────────────────

/** An attribute value. Line breaks become character references: a parser
 * folds a raw one in an attribute into a space. */
const av = (s: string) =>
  xmlEscape(s)
    .replace(/\r/g, "&#xd;")
    .replace(/\n/g, "&#xa;")
    .replace(/\t/g, "&#x9;")

type Val = string | number | undefined

/** Attributes as markup, skipping undefined values; numbers at 0.01 px. */
function attrs(a: Record<string, Val>): string {
  let s = ""
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue
    s += ` ${k}="${av(typeof v === "number" ? fmt(v) : v)}"`
  }
  return s
}

/** A draw.io style: bare names, then `key=value;` pairs. Values are made
 * here - colours through hex6, numbers through fmt, dashes checked - so
 * none can carry a `;` or `=`. */
function style(names: string[], kv: Record<string, Val>): string {
  let s = names.map((n) => `${n};`).join("")
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined) continue
    s += `${k}=${typeof v === "number" ? fmt(v) : v};`
  }
  return s
}

/** User text in an HTML label: escaped for HTML here, and again for XML by
 * `attrs`, so `a<b` reaches the file as `a&amp;lt;b`. */
const h = (s: string) => htmlEscape(s).replace(/\r?\n/g, "<br>")

/** A fraction for a constraint or a relative position: 0.0001 steps. */
function frac(n: number): string {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? "0" : String(r)
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function geometry(r: Rect): string {
  return `<mxGeometry${attrs({ x: r.x, y: r.y, width: r.w, height: r.h })} as="geometry"/>`
}

const point = (p: Pt, as?: string) =>
  `<mxPoint${attrs({ x: p.x, y: p.y, as })}/>`

/** Link targets: web URLs and site paths - never `javascript:` and kin. */
const SAFE_LINK = /^(?:https?:\/\/|\/(?!\/))/i
const safeLink = (href?: string) =>
  href && SAFE_LINK.test(href) ? href : undefined

/** An inlined photo draw.io can embed. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/

/** A node drawn as its photo in this file. */
const drawsImage = (n: DiagramNode | undefined, photos?: boolean) =>
  !!photos && n?.kind === "photo" && !!n.photo && DATA_IMAGE.test(n.photo.href)

/** An SVG dash array as a draw.io `dashPattern`, or undefined. */
function dashPattern(d?: string): string | undefined {
  const t = d?.trim()
  return t && /^[\d.]+(?:[ ,]+[\d.]+)*$/.test(t)
    ? t.split(/[ ,]+/).join(" ")
    : undefined
}

// ── Link ends ────────────────────────────────────────────────────────────

/** Where a line end attaches in the file: a node (or, in Detailed, one of
 * its nubs), at a fixed point given as fractions of that box. */
interface Attach {
  node?: DiagramNode
  /** A breakout junction the end attaches to (at its centre). */
  junction?: DiagramJunction
  /** The nub index when the end attaches to a nub cell. */
  nub?: number
  fx: number
  fy: number
  /** The attach point, absolute. */
  pt: Pt
}

function nearestSide(r: Rect, p: Pt): Side {
  const d: [Side, number][] = [
    ["top", Math.abs(p.y - r.y)],
    ["right", Math.abs(p.x - (r.x + r.w))],
    ["bottom", Math.abs(p.y - (r.y + r.h))],
    ["left", Math.abs(p.x - r.x)],
  ]
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0]
}

/** An end placed on the side of its box it leaves from, keeping its
 * position along that side: a nub's outer edge in Detailed; in Simple, the
 * card side (at the nub's place, or the midpoint a Simple document gives);
 * a photo port moves out to the card edge where photos draw as cards, and
 * stays on its port on a photo drawn as its image. */
function attachEnd(
  end: DiagramEnd,
  node: DiagramNode | undefined,
  mode: DrawioMode,
  photos?: boolean
): Attach {
  if (!node) return { fx: 0, fy: 0, pt: { x: end.x, y: end.y } }
  if (drawsImage(node, photos) && end.marker) {
    const img = node.photo!
    const fx = round4(img.w ? clamp01((end.x - img.x) / img.w) : 0.5)
    const fy = round4(img.h ? clamp01((end.y - img.y) / img.h) : 0.5)
    return {
      node,
      fx,
      fy,
      pt: { x: img.x + fx * img.w, y: img.y + fy * img.h },
    }
  }
  const nub = end.nub !== undefined ? node.nubs?.[end.nub] : undefined
  const onNub = mode === "detailed" && !!nub
  const box: Rect = onNub ? nub : node
  const side =
    (onNub ? nub.side : (end.side ?? nub?.side)) ?? nearestSide(box, end)
  const fx =
    side === "left"
      ? 0
      : side === "right"
        ? 1
        : round4(box.w ? clamp01((end.x - box.x) / box.w) : 0.5)
  const fy =
    side === "top"
      ? 0
      : side === "bottom"
        ? 1
        : round4(box.h ? clamp01((end.y - box.y) / box.h) : 0.5)
  return {
    node,
    nub: onNub ? end.nub : undefined,
    fx,
    fy,
    pt: { x: box.x + fx * box.w, y: box.y + fy * box.h },
  }
}

/** Nodes by document id; the first wins a duplicate. */
function nodesById(nodes: DiagramNode[]): Map<string, DiagramNode> {
  const byId = new Map<string, DiagramNode>()
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n)
  return byId
}

/** An end on a breakout junction: its centre, perimeter off. */
function attachJunction(j: DiagramJunction): Attach {
  return { junction: j, fx: 0.5, fy: 0.5, pt: { x: j.x, y: j.y } }
}

/** A link with its ends moved to where the file attaches them. */
function drawnLink(
  l: DiagramLink,
  nodes: Map<string, DiagramNode>,
  mode: DrawioMode,
  junctions: Map<string, DiagramJunction> = new Map(),
  photos?: boolean
): { link: DiagramLink; a: Attach; b: Attach } {
  const ja = junctions.get(l.source.node)
  const jb = junctions.get(l.target.node)
  const a = ja
    ? attachJunction(ja)
    : attachEnd(l.source, nodes.get(l.source.node), mode, photos)
  const b = jb
    ? attachJunction(jb)
    : attachEnd(l.target, nodes.get(l.target.node), mode, photos)
  return {
    link: {
      ...l,
      source: { ...l.source, x: a.pt.x, y: a.pt.y },
      target: { ...l.target, x: b.pt.x, y: b.pt.y },
    },
    a,
    b,
  }
}

const TOL = 1
const near = (p: Pt, q: Pt) =>
  Math.abs(p.x - q.x) < TOL && Math.abs(p.y - q.y) < TOL

/** An elbow's corners as draw.io's orthogonal router takes them: repeats
 * and points on a straight run dropped (the router reads the hints as
 * alternating horizontal and vertical segments). Null when a segment is
 * not axis-aligned - that route is written point for point instead. */
function elbowCorners(pts: Pt[]): Pt[] | null {
  const first = pts[0]
  const last = pts[pts.length - 1]
  const seq = [first]
  for (const p of pts.slice(1, -1))
    if (!near(p, seq[seq.length - 1])) seq.push(p)
  while (seq.length > 1 && near(seq[seq.length - 1], last)) seq.pop()
  seq.push(last)
  const out = [seq[0]]
  for (let i = 1; i < seq.length - 1; i++) {
    const [a, b, c] = [out[out.length - 1], seq[i], seq[i + 1]]
    const straight =
      (Math.abs(a.x - b.x) < TOL && Math.abs(b.x - c.x) < TOL) ||
      (Math.abs(a.y - b.y) < TOL && Math.abs(b.y - c.y) < TOL)
    if (!straight) out.push(b)
  }
  out.push(seq[seq.length - 1])
  for (let i = 1; i < out.length; i++) {
    const [a, b] = [out[i - 1], out[i]]
    if (Math.abs(a.x - b.x) >= TOL && Math.abs(a.y - b.y) >= TOL) return null
  }
  return out.slice(1, -1)
}

// ── Label positions ──────────────────────────────────────────────────────

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** mxGraph's `mxGraphView.getPoint` for a relative position `x` along an
 * edge's points (terminals and waypoints - the control polygon of a curve),
 * without offsets: how draw.io places an edge label. */
export function drawioPointAt(poly: Pt[], x: number): Pt {
  const segs = poly.slice(1).map((p, i) => dist(poly[i], p))
  const length = segs.reduce((s, n) => s + n, 0)
  if (!segs.length) return { ...(poly[0] ?? { x: 0, y: 0 }) }
  const d = Math.round((x / 2 + 0.5) * length)
  let segment = segs[0]
  let run = 0
  let index = 1
  while (d >= Math.round(run + segment) && index < poly.length - 1) {
    run += segment
    segment = segs[index++]
  }
  const f = segment === 0 ? 0 : (d - run) / segment
  const [p0, pe] = [poly[index - 1], poly[index]]
  return { x: p0.x + (pe.x - p0.x) * f, y: p0.y + (pe.y - p0.y) * f }
}

/** How far along a polyline, 0..1, the point nearest `p` lies. */
function nearestT(poly: Pt[], p: Pt): number {
  let [best, bestD, run] = [0, Infinity, 0]
  for (let i = 1; i < poly.length; i++) {
    const [a, b] = [poly[i - 1], poly[i]]
    const seg = dist(a, b)
    const u = seg
      ? clamp01(
          ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (seg * seg)
        )
      : 0
    const q = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
    const d = dist(p, q)
    if (d < bestD - 1e-9) [best, bestD] = [run + u * seg, d]
    run += seg
  }
  return run ? best / run : 0.5
}

/** Where a label block's box centre is, after its rotation. */
function blockCentre(b: LabelBlock): Pt {
  const c = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 }
  if (!b.rotate) return c
  const r = (b.rotate * Math.PI) / 180
  const [cos, sin] = [Math.cos(r), Math.sin(r)]
  return {
    x: b.ox + (c.x - b.ox) * cos - (c.y - b.oy) * sin,
    y: b.oy + (c.x - b.ox) * sin + (c.y - b.oy) * cos,
  }
}

/** A label's relative position `x` and the offset that lands it on `at`. */
function labelAt(poly: Pt[], at: Pt, x?: string): { x: string; offset: Pt } {
  const rx = x ?? frac(2 * nearestT(poly, at) - 1)
  const q = drawioPointAt(poly, Number(rx))
  return { x: rx, offset: { x: at.x - q.x, y: at.y - q.y } }
}

/** An offset under a pixel each way only undoes draw.io rounding its
 * distance along the line to whole pixels: left out. */
const zeroish = (p: Pt) => Math.abs(p.x) < 1 && Math.abs(p.y) < 1

// ── Pages ────────────────────────────────────────────────────────────────

/** Row bands and zones hold cards; side bands are drawn behind. */
const isContainer = (b: DiagramBand) => b.kind === "zone" || b.orient === "h"

const area = (r: Rect) => r.w * r.h
const holds = (o: Rect, r: Rect) =>
  r.x >= o.x - 0.5 &&
  r.y >= o.y - 0.5 &&
  r.x + r.w <= o.x + o.w + 0.5 &&
  r.y + r.h <= o.y + o.h + 0.5
const contains = (o: Rect, p: Pt) =>
  p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h

function page(
  doc: DiagramDocument,
  index: number,
  opts: DrawioOptions
): string {
  const mode = opts.mode ?? "simple"
  const measure = opts.measure ?? measureText
  const margin = opts.margin ?? 40
  const shift = { x: margin - doc.bounds.x, y: margin - doc.bounds.y }
  const out: string[] = []

  // Ids: the document's own where they are free, so the file lines up with
  // Danbyte; a clash gets a `~n` suffix. Primary ids first, in document
  // order, so the same document always gets the same ids.
  const used = new Set(["0", "1", LAYER_LLDP, LAYER_BGP])
  const take = (want: string) => {
    const base = want || "cell"
    let id = base
    for (let k = 2; used.has(id); k++) id = `${base}~${k}`
    used.add(id)
    return id
  }
  const bandIds = new Map<DiagramBand, string>()
  for (const b of doc.bands) bandIds.set(b, take(b.id))
  const nodeIds = new Map<DiagramNode, string>()
  for (const n of doc.nodes) nodeIds.set(n, take(n.id))
  const linkIds = new Map<DiagramLink, string>()
  for (const l of doc.links) linkIds.set(l, take(l.id))
  const noteIds = new Map<DiagramNote, string>()
  for (const n of doc.notes) noteIds.set(n, take(n.id))
  const junctionIds = new Map<DiagramJunction, string>()
  for (const j of doc.junctions ?? []) junctionIds.set(j, take(j.id))
  const byId = nodesById(doc.nodes)
  const junctionsById = new Map((doc.junctions ?? []).map((j) => [j.id, j]))
  // Nub cells get their ids up front: lines refer to them and are written
  // before the cards that hold them.
  const nubIds = new Map<string, string>()
  const nubKey = (n: DiagramNode, i: number) => `${nodeIds.get(n)}\u0000${i}`
  if (mode === "detailed")
    for (const n of doc.nodes)
      for (let i = 0; i < (n.nubs ?? []).length; i++)
        nubIds.set(nubKey(n, i), take(`${nodeIds.get(n) ?? ""}-nub-${i}`))

  /** A box in its parent's frame: relative to the parent container's
   * corner, or shifted into the page at the top level. */
  const rel = (r: Rect, parent: Rect | null): Rect =>
    parent
      ? { x: r.x - parent.x, y: r.y - parent.y, w: r.w, h: r.h }
      : { x: r.x + shift.x, y: r.y + shift.y, w: r.w, h: r.h }
  const abs = (p: Pt): Pt => ({ x: p.x + shift.x, y: p.y + shift.y })

  // ── Containers: which band or zone holds what ──
  const conts = doc.bands
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => isContainer(b))
  type Cont = (typeof conts)[number]
  const bigger = (d: Cont, c: Cont) =>
    area(d.b) > area(c.b) || (area(d.b) === area(c.b) && d.i < c.i)
  const smallest = (cands: Cont[]) =>
    cands.reduce<Cont | undefined>(
      (best, d) => (!best || bigger(best, d) ? d : best),
      undefined
    )
  const contParent = new Map<Cont, Cont | undefined>()
  for (const c of conts)
    contParent.set(
      c,
      smallest(conts.filter((d) => d !== c && bigger(d, c) && holds(d.b, c.b)))
    )
  const nodeParent = new Map<DiagramNode, Cont | undefined>()
  for (const n of doc.nodes) {
    const centre = { x: n.x + n.w / 2, y: n.y + n.h / 2 }
    nodeParent.set(n, smallest(conts.filter((d) => contains(d.b, centre))))
  }

  // ── Bands ──
  function band(b: DiagramBand, parent: DiagramBand | null, pid: string) {
    const p = bandPaint(b)
    const common = {
      rounded: 1,
      absoluteArcSize: 1,
      arcSize: 2 * BAND.RADIUS,
      html: 1,
      whiteSpace: "wrap",
      collapsible: 0,
      strokeColor: p.edge,
      strokeWidth: p.edgeWidth,
      fontColor: p.ink,
      fontFamily: FONT,
      fontSize: BAND.LABEL_SIZE,
      fontStyle: 1,
    }
    const st =
      b.kind === "zone"
        ? style([], {
            ...common,
            container: 1,
            fillColor: p.fill,
            align: "left",
            verticalAlign: "top",
            spacing: 0,
            spacingLeft: 8,
            spacingTop: 4,
            labelBackgroundColor: p.header,
          })
        : b.orient === "h"
          ? // A row: a swimlane with its title across the top - centred, or
            // where the canvas moved it clear of the lines - one fill for
            // title and body, as on the canvas.
            style(["swimlane"], {
              startSize: Math.min(b.h, BAND.ROW_TITLE),
              swimlaneLine: 0,
              ...common,
              fontSize: BAND.TITLE_SIZE,
              fillColor: p.fill,
              swimlaneFillColor: p.fill,
              ...(b.titleX !== undefined
                ? {
                    align: "left",
                    spacing: 0,
                    spacingLeft: Math.max(
                      0,
                      Math.round(
                        b.titleX -
                          b.x -
                          measure(b.label, BAND.TITLE_SIZE, BAND.LABEL_WEIGHT) /
                            2
                      )
                    ),
                  }
                : {}),
            })
          : // A side band: a plain shape behind the rows (a card has one
            // parent), its big label turned to read bottom to top.
            style([], {
              ...common,
              horizontal: 0,
              container: 0,
              dropTarget: 0,
              fontSize: BAND.SIDE_SIZE,
              fillColor: p.fill,
            })
    out.push(
      `<mxCell${attrs({
        id: bandIds.get(b),
        value: h(b.label),
        style: st,
        vertex: "1",
        parent: pid,
      })}>${geometry(rel(b, parent))}</mxCell>`
    )
  }

  // ── Photos ──
  /** A photo as an image cell (the image box), its name a bold label
   * under it where the canvas put the caption, a connection point and an
   * outline on each marked port, the pill a child under it too. */
  function photo(n: DiagramNode, parent: DiagramBand | null, pid: string) {
    const id = nodeIds.get(n) ?? ""
    const img = n.photo!
    const [, type, data] = DATA_IMAGE.exec(img.href)!
    const t = cardText(n, measure)
    const capW = measure(t.title.text, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT)
    const capTop = t.title.y - baselineAt(0, CARD.TITLE_SIZE, CARD.TITLE_LH)
    const at = (v: number, from: number, len: number) =>
      frac(len ? clamp01((v - from) / len) : 0.5)
    const ports = img.markers.map(
      (m) =>
        `[${at(m.x + m.w / 2, img.x, img.w)},${at(m.y + m.h / 2, img.y, img.h)},0]`
    )
    const st = style(["shape=image"], {
      html: 1,
      imageAspect: 0,
      aspect: "fixed",
      // draw.io's own form: `;base64` is left out, as `;` separates styles.
      image: `data:image/${type},${data}`,
      points: ports.length ? `[${ports.join(",")}]` : undefined,
      verticalLabelPosition: "bottom",
      verticalAlign: "top",
      labelPosition: "center",
      align: "left",
      spacing: 0,
      spacingLeft: Math.max(0, t.title.x - capW / 2 - img.x),
      spacingTop: Math.max(0, capTop - (img.y + img.h)),
      whiteSpace: "nowrap",
      fontFamily: FONT,
      fontSize: CARD.TITLE_SIZE,
      fontStyle: 1,
      fontColor: PRINT.text,
    })
    out.push(
      `<object${attrs({
        label: h(t.title.text),
        danbyte_id: n.id,
        link: safeLink(n.link),
        tooltip: t.title.text !== n.title ? n.title : undefined,
        id,
      })}><mxCell${attrs({ style: st, vertex: "1", parent: pid })}>` +
        `${geometry(rel(img, parent))}</mxCell></object>`
    )
    img.markers.forEach((m, i) =>
      out.push(
        `<mxCell${attrs({
          id: take(`${id}-port-${i}`),
          value: "",
          style: style([], {
            rounded: 1,
            absoluteArcSize: 1,
            arcSize: 2,
            html: 1,
            fillColor: "none",
            strokeColor: PRINT.primary,
            strokeWidth: 1.25,
            movable: 0,
            resizable: 0,
            rotatable: 0,
            editable: 0,
          }),
          vertex: "1",
          connectable: "0",
          parent: id,
        })}>${geometry(rel(m, img))}</mxCell>`
      )
    )
    if (t.pill && n.pill) pillCell(n, t.pill, id, img)
    if (mode !== "detailed") return
    for (const [i, nub] of (n.nubs ?? []).entries()) nubCell(n, i, nub, id, img)
  }

  /** A node's pill: a child cell, placed in its parent's frame. */
  function pillCell(
    n: DiagramNode,
    r: Rect & { text: string },
    id: string,
    frame: Rect
  ) {
    const pf = hex6(n.pill!.fill) ?? PRINT.subtle
    out.push(
      `<mxCell${attrs({
        id: take(`${id}-pill`),
        value: h(r.text),
        style: style([], {
          rounded: 1,
          absoluteArcSize: 1,
          arcSize: 2 * PILL.RADIUS,
          html: 1,
          whiteSpace: "nowrap",
          fillColor: pf,
          strokeColor: PRINT.paper,
          fontColor: hex6(n.pill!.ink) ?? PRINT.paper,
          fontFamily: FONT,
          fontSize: PILL.SIZE,
          spacing: 0,
          movable: 0,
          resizable: 0,
          rotatable: 0,
        }),
        vertex: "1",
        connectable: "0",
        parent: id,
      })}>${geometry(rel(r, frame))}</mxCell>`
    )
  }

  /** A Detailed nub: a child cell lines attach to. */
  function nubCell(
    n: DiagramNode,
    i: number,
    nub: Rect & { label?: string },
    id: string,
    frame: Rect
  ) {
    const nid = nubIds.get(nubKey(n, i)) ?? take(`${id}-nub-${i}`)
    out.push(
      `<object${attrs({ label: "", tooltip: nub.label, id: nid })}>` +
        `<mxCell${attrs({
          style: style([], {
            rounded: 1,
            absoluteArcSize: 1,
            arcSize: 2 * NUB.RADIUS,
            html: 1,
            fillColor: PRINT.faint,
            strokeColor: "none",
            movable: 0,
            resizable: 0,
            rotatable: 0,
            editable: 0,
          }),
          vertex: "1",
          parent: id,
        })}>${geometry(rel(nub, frame))}</mxCell></object>`
    )
  }

  // ── Nodes ──
  function node(n: DiagramNode, parent: DiagramBand | null, pid: string) {
    if (drawsImage(n, opts.photos)) return photo(n, parent, pid)
    const id = nodeIds.get(n) ?? ""
    // Photos draw as their card; the image variant is a later option.
    const card: DiagramNode =
      n.kind === "card"
        ? n
        : { ...n, kind: "card", photo: undefined, place: undefined }
    const t = cardText(card, measure)
    const fill = hex6(n.fill) ?? PRINT.wash
    const ink = hex6(n.ink) ?? PRINT.text
    // Text hangs from the top as on the canvas: the name row where the
    // card layout put it (below the pill when that has a row of its own),
    // the lines under it; a card grown for its nubs keeps the space below.
    const titleTop = t.title.y - baselineAt(0, CARD.TITLE_SIZE, CARD.TITLE_LH)
    const label =
      `<b>${h(t.title.text)}</b>` +
      (t.lines.length
        ? `<br><span style="font-size:${CARD.LINE_SIZE}px">` +
          `${t.lines.map((l) => h(l.text)).join("<br>")}</span>`
        : "")
    const st = style([], {
      rounded: 1,
      absoluteArcSize: 1,
      arcSize: 2 * CARD.RADIUS,
      whiteSpace: "wrap",
      html: 1,
      fillColor: fill,
      strokeColor: mix("#000000", fill, CARD.EDGE_DARKEN),
      strokeWidth: 1,
      fontColor: ink,
      fontFamily: FONT,
      fontSize: CARD.TITLE_SIZE,
      align: "center",
      verticalAlign: "top",
      spacing: 0,
      spacingTop: titleTop - n.y,
    })
    out.push(
      `<object${attrs({
        label,
        danbyte_id: n.id,
        link: safeLink(n.link),
        tooltip: t.title.text !== n.title ? n.title : undefined,
        id,
      })}><mxCell${attrs({ style: st, vertex: "1", parent: pid })}>` +
        `${geometry(rel(n, parent))}</mxCell></object>`
    )
    if (t.pill && n.pill) pillCell(n, t.pill, id, n)
    if (mode !== "detailed") return
    for (const [i, nub] of (n.nubs ?? []).entries()) nubCell(n, i, nub, id, n)
  }

  function container(c: Cont, parent: DiagramBand | null, pid: string) {
    band(c.b, parent, pid)
    const id = bandIds.get(c.b) ?? ""
    for (const d of conts) if (contParent.get(d) === c) container(d, c.b, id)
    for (const n of doc.nodes) if (nodeParent.get(n) === c) node(n, c.b, id)
  }

  // ── Links ──
  const endCell = (a: Attach) =>
    a.junction
      ? junctionIds.get(a.junction)
      : a.node
        ? a.nub !== undefined
          ? nubIds.get(nubKey(a.node, a.nub))
          : nodeIds.get(a.node)
        : undefined

  function link(l: DiagramLink, layer: string) {
    const id = linkIds.get(l) ?? ""
    const {
      link: d,
      a,
      b,
    } = drawnLink(l, byId, mode, junctionsById, opts.photos)
    let kind: Record<string, Val> = { edgeStyle: "none" }
    let points = d.points
    if (d.kind === "elbow") {
      const corners = elbowCorners([a.pt, ...d.points, b.pt])
      if (corners === null)
        kind = { edgeStyle: "none", rounded: 1, arcSize: 2 * ELBOW_RADIUS }
      else if (corners.length) {
        kind = {
          edgeStyle: "orthogonalEdgeStyle",
          rounded: 1,
          arcSize: 2 * ELBOW_RADIUS,
        }
        points = corners
      } else points = []
    } else if (d.kind === "bendy" || d.kind === "cyclical")
      kind = { edgeStyle: "none", curved: 1 }
    const poly = [a.pt, ...points, b.pt]
    const [src, tgt] = [endCell(a), endCell(b)]
    const dash = dashPattern(l.dash)
    const st = style([], {
      ...kind,
      rounded: kind.rounded ?? 0,
      html: 1,
      endArrow: "none",
      startArrow: "none",
      strokeColor: hex6(l.stroke) ?? PRINT.subtle,
      strokeWidth: Math.max(0.25, l.width || 1),
      dashed: dash ? 1 : undefined,
      fixDash: dash ? 1 : undefined,
      dashPattern: dash,
      exitX: src ? frac(a.fx) : undefined,
      exitY: src ? frac(a.fy) : undefined,
      exitPerimeter: src ? 0 : undefined,
      entryX: tgt ? frac(b.fx) : undefined,
      entryY: tgt ? frac(b.fy) : undefined,
      entryPerimeter: tgt ? 0 : undefined,
      fontFamily: FONT,
      fontSize: 10,
      fontColor: PRINT.body,
      fontStyle: l.sem === "ghost" ? 2 : undefined,
      labelBackgroundColor: PRINT.paper,
      labelBorderColor: PRINT.border,
    })

    const blocks = linkLabels(d, measure)
    const midBlock = blocks.find((k) => k.role === "mid")
    let mid = ""
    let midOffset: Pt | undefined
    if (midBlock) {
      mid = midBlock.lines
        .map((line) =>
          line.weight >= 600 ? `<b>${h(line.text)}</b>` : h(line.text)
        )
        .join("<br>")
      const at = labelAt(poly, blockCentre(midBlock), "0")
      if (!zeroish(at.offset)) midOffset = at.offset
    }
    const inner =
      (src ? "" : point(abs(a.pt), "sourcePoint")) +
      (tgt ? "" : point(abs(b.pt), "targetPoint")) +
      (points.length
        ? `<Array as="points">${points.map((p) => point(abs(p))).join("")}</Array>`
        : "") +
      (midOffset ? point(midOffset, "offset") : "")
    const geo = inner
      ? `<mxGeometry relative="1" as="geometry">${inner}</mxGeometry>`
      : `<mxGeometry relative="1" as="geometry"/>`
    out.push(
      `<object${attrs({
        label: mid,
        danbyte_id: l.id,
        danbyte_cable: l.cable,
        link: safeLink(l.link),
        id,
      })}>` +
        `<mxCell${attrs({
          style: st,
          edge: "1",
          parent: layer,
          source: src,
          target: tgt,
        })}>${geo}</mxCell></object>`
    )

    for (const k of blocks) {
      if (k.role === "mid") continue
      const at = labelAt(poly, blockCentre(k))
      const rotation = k.rotate ? ((k.rotate % 360) + 360) % 360 : 0
      // draw.io paints the label background over the glyphs only; a
      // non-breaking space each side keeps the line's gap round the text
      // (labelPadding would pad it vertically too, over a lane 12px off).
      out.push(
        `<mxCell${attrs({
          id: take(`${id}-${k.role}${k.index ?? ""}`),
          value: `&nbsp;${h(k.lines[0]?.text ?? "")}&nbsp;`,
          style: style(["edgeLabel"], {
            html: 1,
            align: "center",
            verticalAlign: "middle",
            resizable: 0,
            points: "[]",
            fontFamily: FONT,
            fontSize: k.size,
            fontColor: PRINT.muted,
            labelBackgroundColor: groundAt(
              doc.bands,
              blockCentre(k),
              PRINT.paper
            ),
            rotation: rotation || undefined,
          }),
          vertex: "1",
          connectable: "0",
          parent: id,
        })}><mxGeometry${attrs({ x: at.x, relative: "1", as: "geometry" })}>` +
          `${zeroish(at.offset) ? `<mxPoint as="offset"/>` : point(at.offset, "offset")}` +
          `</mxGeometry></mxCell>`
      )
    }
  }

  // ── Notes ──
  /** A note as draw.io's own shapes, to restyle there like any other: text
   * as a text cell; a cloud as draw.io's cloud, a building as the network
   * library's and a globe as a circle, each with its caption under it. */
  function note(n: DiagramNote) {
    const lay = noteLayout(n, measure)
    const value = lay.lines.map((l) => h(l.text)).join("<br>")
    const font = {
      fontFamily: FONT,
      fontSize: lay.size,
      fontColor: PRINT.body,
    }
    const cell = (st: string, r: Rect) =>
      out.push(
        `<mxCell${attrs({
          id: noteIds.get(n),
          value,
          style: st,
          vertex: "1",
          parent: "1",
        })}>${geometry(rel(r, null))}</mxCell>`
      )
    if (!lay.icon) {
      if (!lay.lines.length) return
      cell(
        style(["text"], {
          html: 1,
          align: "center",
          verticalAlign: "middle",
          whiteSpace: "nowrap",
          spacing: 0,
          ...(lay.frame
            ? {
                rounded: 1,
                absoluteArcSize: 1,
                arcSize: 2 * NOTE.RADIUS,
                strokeColor: PRINT.border,
                fillColor: PRINT.paper,
              }
            : { strokeColor: "none", fillColor: "none" }),
          ...font,
        }),
        lay.box
      )
      return
    }
    // The shape covers what the Lucide glyph draws of its 24px box.
    const ic = lay.icon
    const k = ic.w / 24
    const [shape, gx, gy, gw, gh] =
      n.icon === "cloud"
        ? (["ellipse;shape=cloud", 2, 5, 20, 14] as const)
        : n.icon === "globe"
          ? (["ellipse", 2, 2, 20, 20] as const)
          : (["shape=mxgraph.networks.business_center", 4, 3, 16, 18] as const)
    const box = { x: ic.x + gx * k, y: ic.y + gy * k, w: gw * k, h: gh * k }
    cell(
      style([shape], {
        html: 1,
        aspect: n.icon === "cloud" ? undefined : "fixed",
        outlineConnect: 0,
        fillColor: "none",
        strokeColor: PRINT.subtle,
        strokeWidth: NOTE.STROKE,
        verticalLabelPosition: "bottom",
        verticalAlign: "top",
        labelPosition: "center",
        align: "center",
        whiteSpace: "nowrap",
        spacing: 0,
        // The caption where the canvas puts it: under the icon's box.
        spacingTop: ic.y + ic.h + NOTE.GAP - (box.y + box.h),
        ...font,
      }),
      box
    )
  }

  // ── Junctions ──
  function junction(j: DiagramJunction) {
    const fill = hex6(j.fill) ?? PRINT.subtle
    out.push(
      `<object${attrs({
        label: "",
        danbyte_id: j.id,
        danbyte_cable: j.cable,
        link: safeLink(j.link),
        id: junctionIds.get(j),
      })}><mxCell${attrs({
        style: style(["ellipse"], {
          aspect: "fixed",
          html: 1,
          fillColor: fill,
          strokeColor: "none",
          resizable: 0,
          rotatable: 0,
          editable: 0,
        }),
        vertex: "1",
        parent: "1",
      })}>${geometry(
        rel({ x: j.x - j.r, y: j.y - j.r, w: 2 * j.r, h: 2 * j.r }, null)
      )}</mxCell></object>`
    )
  }

  // ── The page, back to front ──
  // Bands, then the cards they hold; photos drawn as images; then the
  // lines, so they pass under the cards on the layer and a cable's lead
  // shows over its photo; then the rest of the cards.
  out.push(`<mxCell id="0"/>`, `<mxCell id="1" value="Topology" parent="0"/>`)
  for (const b of doc.bands) if (!isContainer(b)) band(b, null, "1")
  for (const c of conts) if (!contParent.get(c)) container(c, null, "1")
  const early = (n: DiagramNode) => drawsImage(n, opts.photos)
  for (const n of doc.nodes)
    if (!nodeParent.get(n) && early(n)) node(n, null, "1")
  const onLayer = (sem: DiagramLink["sem"]) =>
    sem === "ghost" ? LAYER_LLDP : sem === "bgp" ? LAYER_BGP : "1"
  for (const l of doc.links) if (onLayer(l.sem) === "1") link(l, "1")
  for (const j of doc.junctions ?? []) junction(j)
  for (const n of doc.nodes)
    if (!nodeParent.get(n) && !early(n)) node(n, null, "1")
  for (const n of doc.notes) note(n)
  for (const [layer, name] of [
    [LAYER_LLDP, "Discovered (LLDP)"],
    [LAYER_BGP, "BGP sessions"],
  ] as const) {
    const links = doc.links.filter((l) => onLayer(l.sem) === layer)
    if (!links.length) continue
    out.push(`<mxCell${attrs({ id: layer, value: name, parent: "0" })}/>`)
    for (const l of links) link(l, layer)
  }

  const w = Math.ceil(doc.bounds.w + 2 * margin)
  const ht = Math.ceil(doc.bounds.h + 2 * margin)
  return (
    `<diagram${attrs({ id: `page-${index + 1}`, name: doc.meta.title || `Page-${index + 1}` })}>\n` +
    `<mxGraphModel${attrs({
      grid: "1",
      gridSize: "10",
      guides: "1",
      tooltips: "1",
      connect: "1",
      arrows: "1",
      fold: "1",
      page: "0",
      pageScale: "1",
      pageWidth: w,
      pageHeight: ht,
      math: "0",
      shadow: "0",
      background: PRINT.paper,
    })}>\n<root>\n${out.join("\n")}\n</root>\n</mxGraphModel>\n</diagram>`
  )
}

const EMPTY: DiagramDocument = {
  meta: { title: "", generated_at: "" },
  bounds: { x: 0, y: 0, w: 0, h: 0 },
  bands: [],
  nodes: [],
  links: [],
  notes: [],
}

/** Documents as one .drawio file, a page each (an empty page for none). */
export function toDrawio(
  pages: DiagramDocument[],
  opts: DrawioOptions = {}
): string {
  const list = pages.length ? pages : [EMPTY]
  return [
    `<mxfile${attrs({
      host: "Danbyte",
      agent: "Danbyte",
      modified: list[0].meta.generated_at || undefined,
      compressed: "false",
    })}>`,
    ...list.map((d, i) => page(d, i, opts)),
    `</mxfile>`,
  ].join("\n")
}

/** The document as the draw.io file draws it: photos as cards, nubs only
 * in Detailed, line ends where the file attaches them. */
function drawnDocument(
  doc: DiagramDocument,
  mode: DrawioMode,
  measure: Measure
): DiagramDocument {
  const byId = nodesById(doc.nodes)
  const nodes = doc.nodes.map<DiagramNode>((n) => ({
    ...n,
    kind: "card",
    photo: undefined,
    place: n.kind === "card" ? n.place : undefined,
    nubs: mode === "detailed" ? n.nubs : undefined,
  }))
  const junctions = new Map((doc.junctions ?? []).map((j) => [j.id, j]))
  const links = doc.links.map((l) => drawnLink(l, byId, mode, junctions).link)
  const body = {
    bands: doc.bands,
    nodes,
    links,
    ...(doc.junctions?.length ? { junctions: doc.junctions } : {}),
    notes: doc.notes,
  }
  return {
    meta: { ...doc.meta, mode },
    bounds: documentBounds(body, measure),
    ...body,
  }
}

/** A `.drawio.svg`: the drawing as SVG - it shows anywhere an image does -
 * with the draw.io file in the root's `content` attribute, so draw.io opens
 * it for editing. The SVG draws what the file holds. */
export function toDrawioSvg(
  doc: DiagramDocument,
  opts: DrawioOptions & { svg?: Omit<SvgOptions, "measure"> } = {}
): string {
  const measure = opts.measure ?? measureText
  const shown = drawnDocument(doc, opts.mode ?? "simple", measure)
  const svg = toSvg(shown, { ...opts.svg, measure })
  const file = toDrawio([doc], opts)
  return svg.replace(/^<svg /, `<svg content="${av(file)}" `)
}
