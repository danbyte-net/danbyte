import { xmlEscape } from "@/lib/xml"

import {
  cardText,
  fmt,
  linkLabels,
  linkPath,
  noteLayout,
  pillWidth,
  NOTE,
} from "./geometry"
import type { LabelBlock } from "./geometry"
import { NOTE_ICONS } from "./icons"
import { baselineAt, fit, measureText } from "./measure"
import type { Measure, Weight } from "./measure"
import {
  BAND,
  bandPaint,
  CARD,
  FONT_STACK,
  hex6,
  mix,
  NUB,
  PILL,
  PRINT,
} from "./theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramLink,
  DiagramNode,
  DiagramNote,
  LegendRow,
} from "./types"

// The SVG writer: a DiagramDocument as clean vector markup that opens in a
// browser, Inkscape or Illustrator and survives the PDF sanitizer - shapes,
// paths and text only. No foreignObject, no CSS variables, no `style=`
// attributes, no filters or opacity; every colour is solid hex. Text sits on
// explicit baselines (no `dominant-baseline`, which WeasyPrint only
// approximates), and an end label breaks its line with a box of the page's
// colour rather than a `paint-order` stroke. The output is deterministic:
// the same document gives the same string, byte for byte.

/** A font face to embed as a `data:` URI - the PNG path needs it, because an
 * SVG drawn as an image cannot reach the page's web fonts. */
export interface EmbeddedFont {
  family: string
  /** `data:font/woff2;base64,…` */
  src: string
  /** CSS `font-weight`, e.g. `"100 900"` for the variable face. */
  weight?: string
  unicodeRange?: string
}

export interface SvgOptions {
  /** Space around the drawing, px (24). */
  margin?: number
  /** Page colour; null = transparent. */
  background?: string | null
  embedFont?: EmbeddedFont[]
  /** Wrap cards and links that carry a link in `<a href>` - standalone SVG
   * only; the PDF path must not (WeasyPrint draws `<a>` as text). */
  links?: boolean
  /** The view name, tenant, filters and date under the drawing. */
  titleBlock?: boolean
  /** The legend rows under the drawing. */
  legend?: boolean
  /** Text widths for fitting and label boxes: `measureText` by default,
   * the same measure the canvas card uses. */
  measure?: Measure
  /** Prefix for the few ids the markup needs (photo symbols). */
  idPrefix?: string
}

const esc = xmlEscape
const col = (c: string | null | undefined, fallback: string) =>
  hex6(c) ?? fallback

/** Attributes as markup, skipping undefined values; values escaped. */
function attrs(a: Record<string, string | number | undefined>): string {
  let s = ""
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue
    s += ` ${k}="${esc(typeof v === "number" ? fmt(v) : v)}"`
  }
  return s
}

const el = (name: string, a: Record<string, string | number | undefined>) =>
  `<${name}${attrs(a)}/>`

function text(
  s: string,
  a: Record<string, string | number | undefined>
): string {
  return `<text${attrs(a)}>${esc(s)}</text>`
}

/** Link targets: web URLs and site paths - never `javascript:` and kin. */
const SAFE_LINK = /^(?:https?:\/\/|\/(?!\/))/i
/** Photo sources: raster `data:` URIs, web URLs and site paths. */
const SAFE_IMAGE =
  /^(?:data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$|https?:\/\/|\/(?!\/))/i

const dashOk = (d?: string) =>
  d && /^[\d.]+(?:[ ,]+[\d.]+)*$/.test(d.trim()) ? d.trim() : undefined

/** `2026-09-26T14:05:00Z` → `2026-09-26 14:05 UTC`. */
function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  )
}

// ── Bands ────────────────────────────────────────────────────────────────

function bandSvg(b: DiagramBand, measure: Measure): string {
  const p = bandPaint(b)
  const r = BAND.RADIUS
  const out: string[] = []
  const frame = { x: b.x, y: b.y, width: b.w, height: b.h, rx: r }
  out.push(el("rect", { ...frame, fill: p.fill }))
  const size = BAND.LABEL_SIZE
  const weight = BAND.LABEL_WEIGHT
  if (b.kind === "zone") {
    // A tab in the top-left corner, like the canvas zone.
    const label = fit(b.label, Math.max(0, b.w - 16), size, weight, measure)
    const tw = Math.min(b.w, measure(label, size, weight) + 16)
    const th = Math.min(b.h, BAND.ZONE_HEADER)
    out.push(
      el("path", {
        d:
          `M ${fmt(b.x + r)},${fmt(b.y)} H ${fmt(b.x + tw)} V ${fmt(b.y + th - 4)}` +
          ` Q ${fmt(b.x + tw)},${fmt(b.y + th)} ${fmt(b.x + tw - 4)},${fmt(b.y + th)}` +
          ` H ${fmt(b.x)} V ${fmt(b.y + r)}` +
          ` A ${r} ${r} 0 0 1 ${fmt(b.x + r)},${fmt(b.y)} Z`,
        fill: p.header,
      }),
      text(label, {
        x: b.x + 8,
        y: baselineAt(b.y, size, th),
        "font-size": size,
        "font-weight": weight,
        fill: p.ink,
      })
    )
  } else if (b.orient === "h") {
    // A row: the label runs up a strip down the left side.
    const hw = Math.min(b.w, BAND.ROW_HEADER)
    out.push(
      el("path", {
        d:
          `M ${fmt(b.x + r)},${fmt(b.y)} H ${fmt(b.x + hw)} V ${fmt(b.y + b.h)}` +
          ` H ${fmt(b.x + r)} A ${r} ${r} 0 0 1 ${fmt(b.x)},${fmt(b.y + b.h - r)}` +
          ` V ${fmt(b.y + r)} A ${r} ${r} 0 0 1 ${fmt(b.x + r)},${fmt(b.y)} Z`,
        fill: p.header,
      })
    )
    const cx = b.x + hw / 2
    const cy = b.y + b.h / 2
    const label = fit(b.label, Math.max(0, b.h - 16), size, weight, measure)
    out.push(
      text(label, {
        x: cx,
        y: baselineAt(cy - size, size, 2 * size),
        "text-anchor": "middle",
        transform: `rotate(-90 ${fmt(cx)} ${fmt(cy)})`,
        "font-size": size,
        "font-weight": weight,
        fill: p.ink,
      })
    )
  } else {
    // A column: the label sits in a strip across the top.
    const hh = Math.min(b.h, BAND.COLUMN_HEADER)
    out.push(
      el("path", {
        d:
          `M ${fmt(b.x + r)},${fmt(b.y)} H ${fmt(b.x + b.w - r)}` +
          ` A ${r} ${r} 0 0 1 ${fmt(b.x + b.w)},${fmt(b.y + r)} V ${fmt(b.y + hh)}` +
          ` H ${fmt(b.x)} V ${fmt(b.y + r)} A ${r} ${r} 0 0 1 ${fmt(b.x + r)},${fmt(b.y)} Z`,
        fill: p.header,
      })
    )
    const label = fit(b.label, Math.max(0, b.w - 16), size, weight, measure)
    out.push(
      text(label, {
        x: b.x + b.w / 2,
        y: baselineAt(b.y, size, hh),
        "text-anchor": "middle",
        "font-size": size,
        "font-weight": weight,
        fill: p.ink,
      })
    )
  }
  out.push(
    el("rect", {
      ...frame,
      fill: "none",
      stroke: p.edge,
      "stroke-width": p.edgeWidth,
    })
  )
  return `<g>${out.join("")}</g>`
}

// ── Links ────────────────────────────────────────────────────────────────

function linkSvg(l: DiagramLink): string {
  const dash = dashOk(l.dash)
  return el("path", {
    d: linkPath(l),
    fill: "none",
    stroke: col(l.stroke, PRINT.subtle),
    "stroke-width": Math.max(0.25, l.width || 1),
    "stroke-dasharray": dash,
    // Round caps stretch every dash; dashed lines keep butt caps.
    "stroke-linecap": dash ? undefined : "round",
    "stroke-linejoin": "round",
  })
}

/** A link label. A middle chip is a box with a hairline edge; an end
 * label sits on its line over a box of the page's colour - the gap the
 * line breaks for. */
function labelSvg(b: LabelBlock, page: string): string {
  const out: string[] = []
  const bg = b.chip
    ? { fill: PRINT.paper, stroke: PRINT.border, "stroke-width": 0.75 }
    : { fill: page }
  out.push(
    el("rect", {
      x: b.box.x,
      y: b.box.y,
      width: b.box.w,
      height: b.box.h,
      rx: b.chip ? 3 : undefined,
      ...bg,
    })
  )
  b.lines.forEach((line, i) => {
    out.push(
      text(line.text, {
        x: b.tx,
        y: b.ty + i * b.lh,
        "text-anchor": b.anchor === "start" ? undefined : b.anchor,
        "font-size": b.size,
        "font-weight": line.weight === 400 ? undefined : line.weight,
        "font-style": line.italic ? "italic" : undefined,
        fill: b.chip ? PRINT.body : PRINT.muted,
      })
    )
  })
  const transform = b.rotate
    ? ` transform="rotate(${fmt(b.rotate)} ${fmt(b.ox)} ${fmt(b.oy)})"`
    : ""
  return `<g${transform}>${out.join("")}</g>`
}

// ── Nodes ────────────────────────────────────────────────────────────────

function nodeSvg(
  node: DiagramNode,
  measure: Measure,
  photoId: (href: string) => string
): string {
  // A photo whose source was refused is drawn as its card.
  const n: DiagramNode =
    node.photo && !photoId(node.photo.href)
      ? { ...node, kind: "card", photo: undefined }
      : node
  const out: string[] = []
  const fill = col(n.fill, PRINT.wash)
  const ink = col(n.ink, PRINT.text)
  // Nubs first: the card's edge then closes over where they join.
  for (const nub of n.nubs ?? [])
    out.push(
      el("rect", {
        x: nub.x,
        y: nub.y,
        width: nub.w,
        height: nub.h,
        rx: NUB.RADIUS,
        fill: PRINT.faint,
      })
    )
  const t = cardText(n, measure)
  if (n.kind === "photo" && n.photo) {
    const ph = n.photo
    out.push(
      el("use", {
        href: `#${photoId(ph.href)}`,
        x: ph.x,
        y: ph.y,
        width: ph.w,
        height: ph.h,
      }),
      el("rect", {
        x: ph.x + 0.5,
        y: ph.y + 0.5,
        width: Math.max(0, ph.w - 1),
        height: Math.max(0, ph.h - 1),
        fill: "none",
        stroke: PRINT.rule,
        "stroke-width": 1,
      })
    )
    for (const m of ph.markers)
      out.push(
        el("rect", {
          x: m.x,
          y: m.y,
          width: m.w,
          height: m.h,
          rx: 1,
          fill: "none",
          stroke: PRINT.primary,
          "stroke-width": 1.25,
        })
      )
  } else {
    // The card: solid role fill, a 1px edge of the same hue a step darker,
    // drawn inside the box so the box is the card's true size.
    out.push(
      el("rect", {
        x: n.x + 0.5,
        y: n.y + 0.5,
        width: Math.max(0, n.w - 1),
        height: Math.max(0, n.h - 1),
        rx: CARD.RADIUS - 0.5,
        fill,
        stroke: mix("#000000", fill, CARD.EDGE_DARKEN),
        "stroke-width": 1,
      })
    )
  }
  if (t.pill && n.pill) {
    const pf = col(n.pill.fill, PRINT.subtle)
    out.push(
      el("rect", {
        x: t.pill.x,
        y: t.pill.y,
        width: t.pill.w,
        height: t.pill.h,
        rx: PILL.RADIUS,
        fill: pf,
        // Keeps a pill apart from a card of a similar colour.
        stroke: PRINT.paper,
        "stroke-width": 1,
      }),
      text(t.pill.text, {
        x: t.pill.x + t.pill.w / 2,
        y: baselineAt(t.pill.y, PILL.SIZE, t.pill.h),
        "text-anchor": "middle",
        "font-size": PILL.SIZE,
        "font-weight": PILL.WEIGHT,
        fill: col(n.pill.ink, PRINT.paper),
      })
    )
  }
  // On a photo the name is a caption on the page, not on a fill.
  const titleInk = n.kind === "photo" ? PRINT.text : ink
  const lineInk =
    n.kind === "photo" ? PRINT.muted : mix(ink, fill, CARD.LINE_INK)
  out.push(
    text(t.title.text, {
      x: t.title.x,
      y: t.title.y,
      "text-anchor": "middle",
      "font-size": CARD.TITLE_SIZE,
      "font-weight": CARD.TITLE_WEIGHT,
      fill: titleInk,
    })
  )
  for (const line of t.lines)
    out.push(
      text(line.text, {
        x: line.x,
        y: line.y,
        "text-anchor": "middle",
        "font-size": CARD.LINE_SIZE,
        fill: lineInk,
      })
    )
  return `<g>${out.join("")}</g>`
}

// ── Notes ────────────────────────────────────────────────────────────────

function noteSvg(n: DiagramNote, measure: Measure): string {
  const out: string[] = []
  const icon = n.icon ? NOTE_ICONS[n.icon] : undefined
  if (icon) {
    out.push(
      `<g${attrs({
        transform: `translate(${fmt(n.x)} ${fmt(n.y)}) scale(${(NOTE.ICON / 24).toFixed(4)})`,
        fill: "none",
        stroke: PRINT.subtle,
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })}>` +
        icon.map(([tag, a]) => el(tag, a)).join("") +
        `</g>`
    )
  }
  for (const line of noteLayout(n, measure).lines)
    out.push(
      text(line.text, {
        x: line.x,
        y: line.y,
        "font-size": NOTE.SIZE,
        fill: PRINT.body,
      })
    )
  return `<g>${out.join("")}</g>`
}

// ── Footer: legend and title block ───────────────────────────────────────

const FOOT = {
  PAD: 12,
  ROW: 18,
  SWATCH_W: 14,
  SWATCH_H: 10,
  LINE_W: 22,
  ITEM_GAP: 14,
  LABEL: 10,
  TITLE: 13,
  SUB: 10,
  SMALL: 9,
  TITLE_GAP: 24,
} as const

interface Footer {
  /** The narrowest page that fits the title block beside the widest
   * legend entry. */
  minWidth: number
  heightFor: (width: number) => number
  draw: (x0: number, top: number, width: number) => string
}

function legendItemWidth(r: LegendRow, measure: Measure): number {
  if (r.kind === "pill") return pillWidth(r.label, measure)
  const sw = r.kind === "line" ? FOOT.LINE_W : FOOT.SWATCH_W
  return sw + 5 + measure(r.label, FOOT.LABEL)
}

function legendItem(r: LegendRow, x: number, cy: number, measure: Measure) {
  if (r.kind === "pill") {
    const w = legendItemWidth(r, measure)
    return (
      el("rect", {
        x,
        y: cy - PILL.H / 2,
        width: w,
        height: PILL.H,
        rx: PILL.RADIUS,
        fill: col(r.fill, PRINT.subtle),
      }) +
      text(r.label, {
        x: x + w / 2,
        y: baselineAt(cy - PILL.H / 2, PILL.SIZE, PILL.H),
        "text-anchor": "middle",
        "font-size": PILL.SIZE,
        "font-weight": PILL.WEIGHT,
        fill: col(r.ink, PRINT.paper),
      })
    )
  }
  let swatch: string
  let sw: number
  if (r.kind === "line") {
    sw = FOOT.LINE_W
    const dash = dashOk(r.dash)
    swatch = el("path", {
      d: `M ${fmt(x + 1)},${fmt(cy)} H ${fmt(x + sw - 1)}`,
      stroke: col(r.stroke, PRINT.subtle),
      "stroke-width": r.width ?? 1.25,
      "stroke-dasharray": dash,
      "stroke-linecap": dash ? undefined : "round",
    })
  } else {
    sw = FOOT.SWATCH_W
    const fill = col(r.fill, PRINT.wash)
    swatch = el("rect", {
      x: x + 0.5,
      y: cy - FOOT.SWATCH_H / 2 + 0.5,
      width: sw - 1,
      height: FOOT.SWATCH_H - 1,
      rx: 3,
      fill,
      stroke: mix("#000000", fill, CARD.EDGE_DARKEN),
      "stroke-width": 1,
    })
  }
  return (
    swatch +
    text(r.label, {
      x: x + sw + 5,
      y: baselineAt(cy - FOOT.ROW / 2, FOOT.LABEL, FOOT.ROW),
      "font-size": FOOT.LABEL,
      fill: PRINT.body,
    })
  )
}

/** The strip under the drawing: legend entries flowing from the left, the
 * title block right-aligned. Null when neither is asked for or has content. */
function footer(
  doc: DiagramDocument,
  o: { titleBlock: boolean; legend: boolean },
  measure: Measure
): Footer | null {
  const m = doc.meta
  const rows = o.legend ? (m.legend ?? []).filter((r) => r.label) : []
  const block = o.titleBlock
    ? [
        {
          s: m.title,
          size: FOOT.TITLE,
          weight: 700 as Weight,
          fill: PRINT.text,
        },
        {
          s: [m.tenant, m.filters].filter(Boolean).join(" · "),
          size: FOOT.SUB,
          weight: 400 as Weight,
          fill: PRINT.muted,
        },
        {
          s: [stamp(m.generated_at), m.danbyte_url].filter(Boolean).join(" · "),
          size: FOOT.SMALL,
          weight: 400 as Weight,
          fill: PRINT.subtle,
        },
      ].filter((l) => l.s)
    : []
  if (!rows.length && !block.length) return null

  const blockW = Math.max(
    0,
    ...block.map((l) => measure(l.s, l.size, l.weight))
  )
  const blockH = block.reduce((h, l) => h + l.size + 5, 0)
  const widths = rows.map((r) => legendItemWidth(r, measure))
  const widest = Math.max(0, ...widths)
  const beside = block.length ? blockW + (rows.length ? FOOT.TITLE_GAP : 0) : 0

  /** Legend entries flowed into the space left of the title block. */
  const flow = (width: number) => {
    const avail = Math.max(widest, width - 2 * FOOT.PAD - beside)
    const at: { x: number; row: number }[] = []
    let [x, row] = [0, 0]
    for (const w of widths) {
      if (x > 0 && x + w > avail) {
        row++
        x = 0
      }
      at.push({ x, row })
      x += w + FOOT.ITEM_GAP
    }
    return { at, rows: rows.length ? row + 1 : 0 }
  }

  return {
    minWidth: 2 * FOOT.PAD + beside + widest,
    heightFor: (width) =>
      2 * FOOT.PAD + Math.max(blockH, flow(width).rows * FOOT.ROW),
    draw(x0, top, width) {
      const out: string[] = [
        el("path", {
          d: `M ${fmt(x0 + FOOT.PAD)},${fmt(top)} H ${fmt(x0 + width - FOOT.PAD)}`,
          stroke: PRINT.border,
          "stroke-width": 0.75,
        }),
      ]
      const lay = flow(width)
      rows.forEach((r, i) => {
        const p = lay.at[i]
        out.push(
          legendItem(
            r,
            x0 + FOOT.PAD + p.x,
            top + FOOT.PAD + p.row * FOOT.ROW + FOOT.ROW / 2,
            measure
          )
        )
      })
      let y = top + FOOT.PAD
      for (const l of block) {
        y += l.size
        out.push(
          text(l.s, {
            x: x0 + width - FOOT.PAD,
            y,
            "text-anchor": "end",
            "font-size": l.size,
            "font-weight": l.weight === 400 ? undefined : l.weight,
            fill: l.fill,
          })
        )
        y += 5
      }
      return `<g id="footer">${out.join("")}</g>`
    },
  }
}

// ── Document ─────────────────────────────────────────────────────────────

const FONT_SRC =
  /^data:(?:font\/woff2|application\/font-woff2);base64,[A-Za-z0-9+/=]+$/

function fontFaces(fonts: EmbeddedFont[]): string {
  return fonts
    .filter((f) => FONT_SRC.test(f.src))
    .map((f) => {
      const family = f.family.replace(/[^A-Za-z0-9 -]/g, "")
      const weight = /^\d{3}( \d{3})?$/.test(f.weight ?? "") ? f.weight : "400"
      const range = /^[U+0-9A-Fa-f?,\s-]+$/.test(f.unicodeRange ?? "")
        ? `;unicode-range:${f.unicodeRange}`
        : ""
      return (
        `@font-face{font-family:"${family}";font-style:normal;` +
        `font-weight:${weight};src:url(${f.src}) format("woff2")${range}}`
      )
    })
    .join("")
}

/** The document as an SVG string. */
export function toSvg(doc: DiagramDocument, opts: SvgOptions = {}): string {
  const measure = opts.measure ?? measureText
  const margin = opts.margin ?? 24
  const prefix = (opts.idPrefix ?? "dg-").replace(/[^A-Za-z0-9_-]/g, "")
  const b = doc.bounds

  const foot = footer(
    doc,
    { titleBlock: !!opts.titleBlock, legend: !!opts.legend },
    measure
  )
  const x0 = b.x - margin
  const y0 = b.y - margin
  const width = Math.max(b.w + 2 * margin, foot?.minWidth ?? 0)
  const footH = foot ? foot.heightFor(width) : 0
  const height = b.h + 2 * margin + footH

  // Photos: one symbol per distinct image, drawn with <use>.
  const photos = new Map<string, string>()
  for (const n of doc.nodes)
    if (
      n.kind === "photo" &&
      n.photo &&
      SAFE_IMAGE.test(n.photo.href) &&
      !photos.has(n.photo.href)
    )
      photos.set(n.photo.href, `${prefix}ph${photos.size}`)
  const photoId = (href: string) => photos.get(href) ?? ""

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs({
      width,
      height,
      viewBox: `${fmt(x0)} ${fmt(y0)} ${fmt(width)} ${fmt(height)}`,
      role: "img",
      "font-family": FONT_STACK,
    })}>`
  )
  out.push(`<title>${esc(doc.meta.title)}</title>`)
  const desc = [
    doc.meta.tenant,
    stamp(doc.meta.generated_at),
    `${doc.nodes.length} devices`,
    `${doc.links.length} links`,
  ].filter(Boolean)
  out.push(`<desc>${esc(desc.join(" · "))}</desc>`)

  const faces = opts.embedFont?.length ? fontFaces(opts.embedFont) : ""
  if (faces || photos.size) {
    out.push("<defs>")
    if (faces) out.push(`<style>${faces}</style>`)
    for (const [href, id] of photos)
      out.push(
        `<symbol${attrs({ id, viewBox: "0 0 100 100", preserveAspectRatio: "none" })}>` +
          el("image", {
            width: 100,
            height: 100,
            preserveAspectRatio: "none",
            href,
          }) +
          `</symbol>`
      )
    out.push("</defs>")
  }

  const bg = opts.background === undefined ? PRINT.paper : opts.background
  if (bg !== null)
    out.push(
      el("rect", {
        x: x0,
        y: y0,
        width,
        height,
        fill: col(bg, PRINT.paper),
      })
    )

  const linked = (href: string | undefined, body: string) =>
    opts.links && href && SAFE_LINK.test(href)
      ? `<a${attrs({ href })}>${body}</a>`
      : body

  out.push(`<g id="bands">`)
  for (const band of doc.bands) out.push(bandSvg(band, measure))
  out.push(`</g><g id="links">`)
  for (const l of doc.links) out.push(linked(l.link, linkSvg(l)))
  // Breakout split points sit on their lines.
  for (const j of doc.junctions ?? [])
    out.push(
      linked(
        j.link,
        el("circle", {
          cx: j.x,
          cy: j.y,
          r: j.r,
          fill: col(j.fill, PRINT.subtle),
        })
      )
    )
  out.push(`</g><g id="nodes">`)
  for (const n of doc.nodes)
    out.push(linked(n.link, nodeSvg(n, measure, photoId)))
  out.push(`</g><g id="labels">`)
  for (const l of doc.links)
    for (const block of linkLabels(l, measure))
      out.push(labelSvg(block, col(bg ?? PRINT.paper, PRINT.paper)))
  out.push(`</g>`)
  if (doc.notes.length) {
    out.push(`<g id="notes">`)
    for (const n of doc.notes) out.push(noteSvg(n, measure))
    out.push(`</g>`)
  }
  if (foot) out.push(foot.draw(x0, b.y + b.h + margin, width))
  out.push(`</svg>`)
  return out.join("\n")
}
