import type { Device, DeviceTypeMini, DinRail } from "@/lib/api"
import {
  NAME_PX,
  RAIL_LABEL_PX,
  STRIP_PX,
  nameLayout,
  plateView,
  railTagAt,
} from "@/lib/cabinet-drawing"
import { readableText } from "@/lib/color"
import { fmt } from "@/lib/diagram/geometry"
import { el, stamp, text } from "@/lib/diagram/markup"
import type { EmbeddedFont } from "@/lib/diagram/markup"
import { baselineAt, measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { PRINT, hex6, mix } from "@/lib/diagram/theme"
import { band, deviceBody } from "@/lib/din-geometry"
import { cabinetPhotoBox, effectiveFrontCal } from "@/lib/photo-calibration"

import { PhotoSymbols, svgDocument } from "./draw"
import type { Box } from "./draw"
import type { InlinedPhoto } from "./photos"

// A cabinet's mounting plate as a vector drawing (#277), as its page draws
// it in Names and Images - built from the cabinet and its devices, never read
// off the screen. It is the SVG export, the PNG (that SVG rasterised) and the
// drawing on the PDF's sheet.
//
// The plate is drawn true to its millimetres, one px to the mm, inside its
// box when the box's size is known; each rail is a band of its profile's
// height, and each device sits on its rail at its offset, its type's size,
// the rail's centreline across it where its type says. Names: a box in the
// role's colour with the name. Images: the type's front photo - a calibrated
// one at its true size, its left guide on the device's left edge and its rail
// line on the rail, cut to the device; any other stretched over it - and the
// name on a strip across its top. The names and the rails' labels go where
// the page puts them (lib/cabinet-drawing.ts).

export type PlateLook = "names" | "images"

/** What the drawing reads off a cabinet. */
export interface ElevationCabinet {
  name: string
  inner_width_mm: number
  inner_height_mm: number
  outer_width_mm: number | null
  outer_height_mm: number | null
  rails: readonly DinRail[]
  site?: { name: string } | null
  location?: { name: string } | null
}

/** What the drawing reads off a device in the cabinet. */
export type PlateDevice = Pick<
  Device,
  "id" | "name" | "din_rail" | "din_offset_mm" | "image_ports"
> & {
  role: { color: string } | null
  device_type: Pick<
    DeviceTypeMini,
    "width_mm" | "height_mm" | "din_rail_mm" | "front_image" | "front_cal"
  > | null
}

export interface CabinetSvgOptions {
  look?: PlateLook
  /** Each device's name on its body. On by default. */
  labels?: boolean
  /** The rails' labels. On by default. */
  railTags?: boolean
  /** Photos inlined by `inlinePhotos`, by URL; a photo not here - or a
   * calibrated one without its aspect - is drawn as its Names box. */
  photos?: ReadonlyMap<string, InlinedPhoto>
  /** The cabinet's name and facts over the drawing. Off on the PDF, whose
   * sheet has a title block. */
  heading?: boolean
  /** When the drawing was made (ISO), for the heading. */
  generatedAt?: string
  /** Written on a plate with no rails. */
  emptyText?: string
  embedFont?: EmbeddedFont[]
  /** Text widths: `measureText` by default. */
  measure?: Measure
  /** Prefix for the drawing's ids (`cb-`). */
  idPrefix?: string
}

export const CABINET_SVG = {
  /** px per plate mm: the plate true to its millimetres. */
  PX_PER_MM: 1,
  MARGIN: 16,
  NAME_SIZE: NAME_PX,
  STRIP: STRIP_PX,
  RAIL_LABEL_SIZE: RAIL_LABEL_PX,
  EMPTY_SIZE: 12,
  TITLE_SIZE: 14,
  FACTS_SIZE: 10,
  HEAD_GAP: 16,
} as const

const S = CABINET_SVG

/** The page's tokens, solid: the box `bg-muted/60`, the plate the page's
 * background, the rails `muted-foreground` at 20% with a 60% edge. */
const INK = {
  box: mix(PRINT.wash, PRINT.paper, 0.6),
  plate: PRINT.tint,
  rail: mix(PRINT.subtle, PRINT.tint, 0.2),
  railEdge: mix(PRINT.subtle, PRINT.tint, 0.6),
} as const

/** The baseline that centres one line of `size` px text on `y`, as the
 * page's `dominant-baseline: central` does (WeasyPrint only approximates
 * that, so the writers place baselines themselves). */
const central = (y: number, size: number) =>
  baselineAt(y - size / 2, size, size)

interface Placed {
  d: PlateDevice
  rail: DinRail
  /** The device's body, plate mm. */
  body: Box
}

/** The devices with a place on the plate: on one of its rails, with a type
 * that has a size. */
function placed(
  cabinet: ElevationCabinet,
  devices: readonly PlateDevice[]
): Placed[] {
  const rails = new Map(cabinet.rails.map((r) => [r.id, r]))
  const out: Placed[] = []
  for (const d of devices) {
    const rail = d.din_rail ? rails.get(d.din_rail.id) : undefined
    const b = rail ? deviceBody(rail, d.din_offset_mm, d.device_type) : null
    if (rail && b)
      out.push({ d, rail, body: { x: b.x, y: b.y, w: b.width, h: b.height } })
  }
  return out
}

/** Where a device's front photo goes, plate mm: stretched over its body,
 * or - calibrated - at its true size; null without one (or, calibrated,
 * without its aspect to size it by). */
function photoBox(
  p: Placed,
  aspect: number | null
): { href: string; box: Box; calibrated: boolean } | null {
  const href = p.d.device_type?.front_image
  if (!href) return null
  const cal = effectiveFrontCal(p.d)
  if (!cal) return { href, box: p.body, calibrated: false }
  if (!aspect) return null
  const b = cabinetPhotoBox(p.body, cal, aspect, p.rail.y_mm)
  return {
    href,
    calibrated: true,
    box: { x: b.x, y: b.y, w: b.width, h: b.height },
  }
}

/** The photos a drawing with these options shows, each with the widest it
 * is drawn, px - what `inlinePhotos` fetches before `cabinetSvg` draws. A
 * calibrated photo is drawn at its true width, cut to its device. */
export function cabinetPhotoRequests(
  cabinet: ElevationCabinet,
  devices: readonly PlateDevice[],
  opts: Pick<CabinetSvgOptions, "look"> = {}
): Map<string, number> {
  const out = new Map<string, number>()
  if ((opts.look ?? "images") !== "images") return out
  for (const p of placed(cabinet, devices)) {
    const href = p.d.device_type?.front_image
    if (!href) continue
    const cal = effectiveFrontCal(p.d)
    const w = (cal ? cal.photo_mm : p.body.w) * S.PX_PER_MM
    out.set(href, Math.max(out.get(href) ?? 0, w))
  }
  return out
}

/** The cabinet's plate as an SVG string - deterministic: the same cabinet,
 * devices and options give the same file, byte for byte. */
export function cabinetSvg(
  cabinet: ElevationCabinet,
  devices: readonly PlateDevice[],
  opts: CabinetSvgOptions = {}
): string {
  const measure = opts.measure ?? measureText
  const prefix = (opts.idPrefix ?? "cb-").replace(/[^A-Za-z0-9_-]/g, "")
  const look = opts.look ?? "images"
  const labels = opts.labels ?? true
  const railTags = opts.railTags ?? true
  const photos = new PhotoSymbols(opts.photos ?? new Map(), prefix)
  const k = S.PX_PER_MM
  /** Screen px as plate mm, at the drawing's scale. */
  const px = (n: number) => n / k

  const w = cabinet.inner_width_mm
  const h = cabinet.inner_height_mm
  const view = plateView(w, h, cabinet.outer_width_mm, cabinet.outer_height_mm)
  const facts = [
    cabinet.site?.name,
    cabinet.location?.name,
    `Plate ${fmt(w)} × ${fmt(h)} mm`,
    opts.generatedAt ? stamp(opts.generatedAt) : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const heading = opts.heading === false ? null : { title: cabinet.name, facts }
  const top =
    S.MARGIN + (heading ? S.TITLE_SIZE + 6 + S.FACTS_SIZE + S.HEAD_GAP : 0)
  const headW = heading
    ? 2 * S.MARGIN +
      Math.max(
        measure(heading.title, S.TITLE_SIZE, 700),
        measure(heading.facts, S.FACTS_SIZE)
      )
    : 0
  const width = Math.ceil(Math.max(2 * S.MARGIN + view.w * k, headW))
  const height = Math.ceil(top + view.h * k + S.MARGIN)
  // The plate's top-left corner on the page.
  const ox = S.MARGIN - view.x * k
  const oy = top - view.y * k
  const at = (b: Box): Box => ({
    x: ox + b.x * k,
    y: oy + b.y * k,
    w: b.w * k,
    h: b.h * k,
  })
  const rect = (b: Box, a: Record<string, string | number | undefined>) =>
    el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, ...a })

  const body: string[] = []
  if (heading)
    body.push(
      `<g id="${prefix}heading">` +
        text(heading.title, {
          x: S.MARGIN,
          y: S.MARGIN + S.TITLE_SIZE,
          "font-size": S.TITLE_SIZE,
          "font-weight": 700,
          fill: PRINT.text,
        }) +
        text(heading.facts, {
          x: S.MARGIN,
          y: S.MARGIN + S.TITLE_SIZE + 6 + S.FACTS_SIZE,
          "font-size": S.FACTS_SIZE,
          fill: PRINT.muted,
        }) +
        `</g>`
    )

  // The box, the plate and the rails.
  const plate: string[] = []
  if (view.box)
    plate.push(
      rect(
        at({
          x: -(view.box.w - w) / 2,
          y: -(view.box.h - h) / 2,
          w: view.box.w,
          h: view.box.h,
        }),
        { rx: 6, fill: INK.box, stroke: PRINT.border, "stroke-width": 1 }
      )
    )
  plate.push(
    rect(at({ x: 0, y: 0, w, h }), {
      rx: 3,
      fill: INK.plate,
      stroke: PRINT.border,
      "stroke-width": 1,
    })
  )
  if (!cabinet.rails.length && opts.emptyText)
    plate.push(
      text(opts.emptyText, {
        x: ox + (w / 2) * k,
        y: central(oy + (h / 2) * k, S.EMPTY_SIZE),
        "text-anchor": "middle",
        "font-size": S.EMPTY_SIZE,
        fill: PRINT.subtle,
      })
    )
  for (const r of cabinet.rails) {
    const [t, b] = band(r)
    plate.push(
      rect(at({ x: r.x_mm, y: t, w: r.length_mm, h: b - t }), {
        rx: 2,
        fill: INK.rail,
        stroke: INK.railEdge,
        "stroke-width": 1,
      })
    )
  }
  body.push(`<g id="${prefix}plate">${plate.join("")}</g>`)

  // The devices: photo or box, name, outline.
  const onPlate = placed(cabinet, devices)
  const clips: string[] = []
  const parts: string[] = []
  for (const p of onPlate) {
    const bodyBox = at(p.body)
    const href = look === "images" ? p.d.device_type?.front_image : null
    const photo = href ? photos.get(href) : null
    const shown = photo ? photoBox(p, photo.aspect) : null
    const fill = shown ? null : hex6(p.d.role?.color)
    if (shown) {
      if (shown.calibrated) {
        const id = `${prefix}clip${clips.length}`
        clips.push(`<clipPath id="${id}">${rect(bodyBox, {})}</clipPath>`)
        parts.push(
          photos.use(shown.href, at(shown.box), { "clip-path": `url(#${id})` })
        )
      } else parts.push(photos.use(shown.href, bodyBox))
    } else parts.push(rect(bodyBox, { fill: fill ?? PRINT.paper }))

    const label = labels
      ? nameLayout(p.d.name, p.body.w / px(1), p.body.h / px(1), !!shown)
      : null
    if (label) {
      if (shown && !label.vertical)
        parts.push(
          rect(
            { ...bodyBox, h: Math.min(bodyBox.h, S.STRIP) },
            { fill: PRINT.tint }
          )
        )
      const cx = bodyBox.x + bodyBox.w / 2
      const cy = label.vertical
        ? bodyBox.y + bodyBox.h / 2
        : bodyBox.y + S.STRIP / 2
      const ink = fill ? (hex6(readableText(fill)) ?? PRINT.text) : PRINT.text
      parts.push(
        text(label.text, {
          x: cx,
          y: central(cy, S.NAME_SIZE),
          "text-anchor": "middle",
          transform: label.vertical
            ? `rotate(90 ${fmt(cx)} ${fmt(cy)})`
            : undefined,
          "font-size": S.NAME_SIZE,
          "font-weight": 500,
          fill: ink,
        })
      )
    }
    parts.push(
      rect(bodyBox, { fill: "none", stroke: PRINT.border, "stroke-width": 1 })
    )
  }
  body.push(`<g id="${prefix}devices">${parts.join("")}</g>`)

  // The rails' labels: at each rail's left end on a bare plate; with
  // devices, in the first stretch they leave free, or over the first one.
  if (railTags) {
    const tags: string[] = []
    for (const r of cabinet.rails) {
      const tag = onPlate.length
        ? railTagAt(r, devices, px)
        : { offset: 0, width: 0, covered: false }
      if (tag.covered)
        tags.push(
          rect(
            at({
              x: r.x_mm + px(3),
              y: r.y_mm - px(7),
              w: tag.width - px(2),
              h: px(14),
            }),
            { rx: 2, fill: PRINT.tint }
          )
        )
      tags.push(
        text(r.label, {
          x: ox + (r.x_mm + tag.offset + px(6)) * k,
          y: central(oy + r.y_mm * k, S.RAIL_LABEL_SIZE),
          "font-size": S.RAIL_LABEL_SIZE,
          "font-weight": 500,
          fill: PRINT.text,
        })
      )
    }
    body.push(`<g id="${prefix}rail-tags">${tags.join("")}</g>`)
  }

  return svgDocument({
    width,
    height,
    title: `${cabinet.name} plate`,
    desc: [
      `Plate ${fmt(w)} × ${fmt(h)} mm`,
      `${cabinet.rails.length} rail${cabinet.rails.length === 1 ? "" : "s"}`,
      `${onPlate.length} device${onPlate.length === 1 ? "" : "s"}`,
      look === "images" ? "Images" : "Names",
    ].join(" · "),
    defs: photos.defs() + clips.join(""),
    embedFont: opts.embedFont,
    body,
  })
}
