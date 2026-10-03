import type { Device, DeviceTypeMini } from "@/lib/api"
import { readableText } from "@/lib/color"
import { fmt } from "@/lib/diagram/geometry"
import { el, stamp, text } from "@/lib/diagram/markup"
import type { EmbeddedFont } from "@/lib/diagram/markup"
import { baselineAt, fit, measureText } from "@/lib/diagram/measure"
import type { Measure, Weight } from "@/lib/diagram/measure"
import { PRINT, hex6, mix } from "@/lib/diagram/theme"
import { OPENING_MM, PANEL_MM } from "@/lib/faceplate-geometry"
import { unitRow } from "@/lib/rack-placement"

import { PhotoSymbols, hatchPath, svgDocument } from "./draw"
import type { Box } from "./draw"
import type { InlinedPhoto } from "./photos"

// A rack's elevation as a vector drawing (#248): one face, or the front and
// rear side by side under their names, as the rack page draws them in Names
// and Images - built from the rack and its devices, never read off the
// screen. It is the SVG export, the PNG (that SVG rasterised) and the drawing
// on the PDF's sheet.
//
// Each face is the rack's frame with the units numbered beside it in the
// rack's own numbering (`starting_unit`, `desc_units`), its devices in their
// units - half-width ones in their half - and a lane down either side for
// the 0U strips on that rail. A device takes its own face; a full-depth one
// is hatched on the other, and a shallow one is left off it, as on screen.
// Names: each device a block in its role's colour (white with the rack
// role's stripe where it has none) with its name and, past 1U, its height.
// Images: the type's photo over the block, and with labels the name on a
// chip; a device whose photo is missing keeps its Names block.

export type ElevationFace = "front" | "rear"
export type ElevationLook = "names" | "images"

/** What the drawing reads off a rack. */
export interface ElevationRack {
  name: string
  u_height: number
  starting_unit: number
  desc_units: boolean
  /** Rail width, inches. */
  width: number
  role?: { color: string } | null
  site?: { name: string } | null
  location?: { name: string } | null
  /** Units its devices take, as the rack page counts them. */
  used_units?: number
}

/** What the drawing reads off a device in the rack. */
export type ElevationDevice = Pick<
  Device,
  | "id"
  | "name"
  | "position"
  | "face"
  | "rack_side"
  | "rack_width"
  | "mount"
  | "u_height"
> & {
  role: { color: string } | null
  device_type: Pick<
    DeviceTypeMini,
    "is_full_depth" | "front_image" | "rear_image"
  > | null
}

export interface RackSvgOptions {
  /** The faces, side by side in this order: both by default. */
  faces?: readonly ElevationFace[]
  look?: ElevationLook
  /** Images: each photo's name on a chip. On by default. */
  labels?: boolean
  /** Photos inlined by `inlinePhotos`, by URL. A photo not here is drawn as
   * its device's Names block. */
  photos?: ReadonlyMap<string, InlinedPhoto>
  /** The rack's name and facts over the drawing. Off on the PDF, whose
   * sheet has a title block. */
  heading?: boolean
  /** When the drawing was made (ISO), for the heading. */
  generatedAt?: string
  embedFont?: EmbeddedFont[]
  /** Text widths: `measureText` by default. */
  measure?: Measure
  /** Prefix for the drawing's ids (`rk-`). */
  idPrefix?: string
}

export const RACK_SVG = {
  /** px per mm: the rack page's own zoom for Names and Images. */
  PX_PER_MM: 0.6,
  MARGIN: 16,
  /** Between the faces. */
  FACE_GAP: 32,
  /** A face's name, over its frame. */
  FACE_SIZE: 10,
  FACE_ROW: 20,
  FRAME_PAD: 6,
  FRAME_RADIUS: 10,
  /** A 0U lane beside the units, and its strips. */
  LANE_W: 28,
  LANE_GAP: 6,
  STRIP_GAP: 4,
  STRIP_RADIUS: 4,
  STRIP_SIZE: 10,
  /** The unit numbers beside the frame. */
  RULER_SIZE: 9,
  RULER_GAP: 6,
  NAME_SIZE: 12,
  NAME_WEIGHT: 500 as Weight,
  SMALL_SIZE: 10,
  PAD_X: 8,
  /** A role-less device's stripe in the rack role's colour. */
  ACCENT_W: 3,
  CHIP_SIZE: 11,
  CHIP_H: 18,
  CHIP_PAD: 6,
  HATCH_PERIOD: 7,
  HATCH_WIDTH: 2,
  TITLE_SIZE: 14,
  FACTS_SIZE: 10,
  HEAD_GAP: 16,
} as const

const S = RACK_SVG

/** The page's tokens over white, solid: `bg-muted/30` units with
 * `border-border/60` between them, `bg-muted/60` strips, a photo's
 * `bg-zinc-950` ground, and the hatching's 18% of the ink. */
const BAND = mix(PRINT.wash, PRINT.paper, 0.3)
const INK = {
  band: BAND,
  rule: mix(PRINT.border, PRINT.paper, 0.6),
  strip: mix(PRINT.wash, PRINT.paper, 0.6),
  photoGround: "#09090b",
  hatch: mix("#09090b", BAND, 0.18),
  hatchEdge: mix(PRINT.border, BAND, 0.6),
} as const

/** A device in a face's units. */
interface Block {
  d: ElevationDevice
  box: Box
  /** Taken from the other face by a full-depth device mounted there. */
  hatched: boolean
}

interface FaceLayout {
  face: ElevationFace
  /** Left edge of the face's column (its unit numbers). */
  x: number
  width: number
  frame: Box
  grid: Box
  ruler: { right: number }
  lanes: { left: Box | null; right: Box | null }
  strips: { left: ElevationDevice[]; right: ElevationDevice[] }
  blocks: Block[]
}

const mounted = (d: ElevationDevice): ElevationFace =>
  d.face === "rear" ? "rear" : "front"

/** The units top to bottom: the highest first, or the lowest when the rack
 * numbers downward. */
function unitsTopDown(rack: ElevationRack): number[] {
  const first = rack.starting_unit
  const out: number[] = []
  for (let i = 0; i < rack.u_height; i++)
    out.push(rack.desc_units ? first + i : first + rack.u_height - 1 - i)
  return out
}

/** A face's devices in their units: its own, and the full-depth ones
 * mounted on the other face, hatched - those under the rest. */
function blocksOf(
  rack: ElevationRack,
  devices: readonly ElevationDevice[],
  face: ElevationFace,
  grid: Box,
  rowH: number
): Block[] {
  const out: Block[] = []
  for (const d of devices) {
    if (d.position == null || d.mount) continue
    const own = mounted(d) === face
    if (!own && !(d.device_type?.is_full_depth ?? true)) continue
    const h = Math.max(1, d.u_height)
    const top = rack.desc_units ? d.position : d.position + h - 1
    const first = Math.max(1, unitRow(rack, top))
    const last = Math.min(rack.u_height, unitRow(rack, top) + h - 1)
    if (last < first) continue
    const half = d.rack_width === "half"
    const right = half && d.rack_side === "right"
    const w = half ? grid.w / 2 : grid.w
    out.push({
      d,
      hatched: !own,
      box: {
        x: grid.x + (right ? grid.w / 2 : 0),
        y: grid.y + (first - 1) * rowH,
        w,
        h: (last - first + 1) * rowH,
      },
    })
  }
  // The other face's gear first, so a device mounted here draws over it.
  return [...out.filter((b) => b.hatched), ...out.filter((b) => !b.hatched)]
}

/** The 0U strips on one rail that show on `face`: those in its channel,
 * and those with none, which show on both. */
function stripsOf(
  devices: readonly ElevationDevice[],
  face: ElevationFace,
  side: "side_left" | "side_right"
): ElevationDevice[] {
  return devices.filter((d) => d.mount === side && (!d.face || d.face === face))
}

interface Layout {
  width: number
  height: number
  rowH: number
  top: number
  faces: FaceLayout[]
  heading: { title: string; facts: string } | null
}

function layout(
  rack: ElevationRack,
  devices: readonly ElevationDevice[],
  opts: RackSvgOptions,
  measure: Measure
): Layout {
  const faces = opts.faces?.length ? opts.faces : (["front", "rear"] as const)
  const rowH = Math.round(PANEL_MM.uPitch * S.PX_PER_MM)
  const panelMm =
    (OPENING_MM[rack.width] ?? PANEL_MM.opening) +
    (PANEL_MM.earWidth - PANEL_MM.opening)
  const gridW = Math.round(panelMm * S.PX_PER_MM)
  const gridH = rack.u_height * rowH
  const rulerW = Math.ceil(
    Math.max(
      0,
      ...unitsTopDown(rack).map((u) => measure(String(u), S.RULER_SIZE))
    )
  )

  const facts = [
    rack.site?.name,
    rack.location?.name,
    `${rack.width}″`,
    rack.used_units != null
      ? `${rack.used_units} / ${rack.u_height} U`
      : `${rack.u_height} U`,
    opts.generatedAt ? stamp(opts.generatedAt) : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const heading =
    opts.heading === false ? null : { title: rack.name, facts: facts }
  const top =
    S.MARGIN + (heading ? S.TITLE_SIZE + 6 + S.FACTS_SIZE + S.HEAD_GAP : 0)

  let x = S.MARGIN
  const out: FaceLayout[] = faces.map((face) => {
    const strips = {
      left: stripsOf(devices, face, "side_left"),
      right: stripsOf(devices, face, "side_right"),
    }
    const lane = (on: boolean) => (on ? S.LANE_W + S.LANE_GAP : 0)
    const frame: Box = {
      x: x + rulerW + S.RULER_GAP,
      y: top + S.FACE_ROW,
      w:
        2 * S.FRAME_PAD +
        lane(strips.left.length > 0) +
        gridW +
        lane(strips.right.length > 0),
      h: 2 * S.FRAME_PAD + gridH,
    }
    const grid: Box = {
      x: frame.x + S.FRAME_PAD + lane(strips.left.length > 0),
      y: frame.y + S.FRAME_PAD,
      w: gridW,
      h: gridH,
    }
    const laneBox = (lx: number): Box => ({
      x: lx,
      y: grid.y,
      w: S.LANE_W,
      h: grid.h,
    })
    const f: FaceLayout = {
      face,
      x,
      width: rulerW + S.RULER_GAP + frame.w,
      frame,
      grid,
      ruler: { right: x + rulerW },
      lanes: {
        left: strips.left.length ? laneBox(frame.x + S.FRAME_PAD) : null,
        right: strips.right.length
          ? laneBox(grid.x + grid.w + S.LANE_GAP)
          : null,
      },
      strips,
      blocks: blocksOf(rack, devices, face, grid, rowH),
    }
    x += f.width + S.FACE_GAP
    return f
  })

  const facesW = x - S.FACE_GAP + S.MARGIN
  const headW = heading
    ? 2 * S.MARGIN +
      Math.max(
        measure(heading.title, S.TITLE_SIZE, 700),
        measure(heading.facts, S.FACTS_SIZE)
      )
    : 0
  return {
    width: Math.ceil(Math.max(facesW, headW)),
    height: top + S.FACE_ROW + 2 * S.FRAME_PAD + gridH + S.MARGIN,
    rowH,
    top,
    faces: out,
    heading,
  }
}

/** The photo a block shows: on its own face, its type's front photo - the
 * face you are looking at is its front. */
function photoOf(b: Block, face: ElevationFace): string | null {
  if (b.hatched) return null
  const t = b.d.device_type
  return (face === mounted(b.d) ? t?.front_image : t?.rear_image) || null
}

/** The photos a drawing with these options shows, each with the widest it
 * is drawn, px - what `inlinePhotos` fetches before `rackSvg` draws. */
export function rackPhotoRequests(
  rack: ElevationRack,
  devices: readonly ElevationDevice[],
  opts: Pick<RackSvgOptions, "faces" | "look"> = {}
): Map<string, number> {
  const out = new Map<string, number>()
  if (opts.look !== "images") return out
  const lay = layout(rack, devices, { ...opts, heading: false }, () => 0)
  for (const f of lay.faces)
    for (const b of f.blocks) {
      const href = photoOf(b, f.face)
      if (href) out.set(href, Math.max(out.get(href) ?? 0, b.box.w))
    }
  return out
}

/** A device's block in Names: its role's colour, or white with the rack
 * role's stripe; its name, and its height past 1U. */
function namesBlock(b: Block, accent: string | null, measure: Measure): string {
  const { x, y, w, h } = b.box
  const fill = hex6(b.d.role?.color)
  const out: string[] = [
    el("rect", {
      x: x + 0.5,
      y: y + 0.5,
      width: Math.max(0, w - 1),
      height: Math.max(0, h - 1),
      fill: fill ?? PRINT.paper,
      stroke: PRINT.border,
      "stroke-width": 1,
    }),
  ]
  const stripe = !fill && accent
  if (stripe)
    out.push(el("rect", { x, y, width: S.ACCENT_W, height: h, fill: accent }))
  // The ink that reads on the role's colour; the height a step quieter.
  const onFill = fill ? (hex6(readableText(fill)) ?? PRINT.text) : null
  const ink = {
    text: onFill ?? PRINT.text,
    sub: onFill && fill ? mix(onFill, fill, 0.8) : PRINT.subtle,
  }
  out.push(...blockText(b, stripe ? S.ACCENT_W : 1, ink, measure))
  return out.join("")
}

/** A block's name at its left and, past 1U, its height at its right -
 * centred on the block's height, cut to the room between them. */
function blockText(
  b: Block,
  inset: number,
  ink: { text: string; sub: string },
  measure: Measure
): string[] {
  const { x, y, w, h } = b.box
  const out: string[] = []
  const tall = b.d.u_height > 1 ? `${b.d.u_height}U` : ""
  const tallW = tall ? measure(tall, S.SMALL_SIZE) + S.PAD_X : 0
  const left = x + inset + S.PAD_X
  const name = fit(
    b.d.name,
    Math.max(0, x + w - S.PAD_X - tallW - left),
    S.NAME_SIZE,
    S.NAME_WEIGHT,
    measure
  )
  if (name)
    out.push(
      text(name, {
        x: left,
        y: baselineAt(y, S.NAME_SIZE, h),
        "font-size": S.NAME_SIZE,
        "font-weight": S.NAME_WEIGHT,
        fill: ink.text,
      })
    )
  if (tall && w - 2 * S.PAD_X - inset >= tallW)
    out.push(
      text(tall, {
        x: x + w - S.PAD_X,
        y: baselineAt(y, S.SMALL_SIZE, h),
        "text-anchor": "end",
        "font-size": S.SMALL_SIZE,
        fill: ink.sub,
      })
    )
  return out
}

/** A block taken from the other face: hatched, outlined faintly, its name
 * muted. */
function hatchedBlock(b: Block, measure: Measure): string {
  const { x, y, w, h } = b.box
  return [
    el("path", {
      d: hatchPath(b.box, S.HATCH_PERIOD, S.HATCH_WIDTH),
      fill: INK.hatch,
    }),
    el("rect", {
      x: x + 0.5,
      y: y + 0.5,
      width: Math.max(0, w - 1),
      height: Math.max(0, h - 1),
      fill: "none",
      stroke: INK.hatchEdge,
      "stroke-width": 1,
    }),
    ...blockText(b, 1, { text: PRINT.subtle, sub: PRINT.subtle }, measure),
  ].join("")
}

/** A block in Images: the photo over the block on the page's dark ground,
 * the rack role's stripe, and with labels the name on a chip. */
function photoBlock(
  b: Block,
  href: string,
  photos: PhotoSymbols,
  accent: string | null,
  labels: boolean,
  measure: Measure
): string {
  const { x, y, w, h } = b.box
  const out = [
    el("rect", { x, y, width: w, height: h, fill: INK.photoGround }),
    photos.use(href, b.box),
  ]
  if (accent)
    out.push(el("rect", { x, y, width: S.ACCENT_W, height: h, fill: accent }))
  out.push(
    el("rect", {
      x: x + 0.5,
      y: y + 0.5,
      width: Math.max(0, w - 1),
      height: Math.max(0, h - 1),
      fill: "none",
      stroke: PRINT.border,
      "stroke-width": 1,
    })
  )
  const chipH = Math.min(S.CHIP_H, h - 4)
  if (labels && chipH >= 12) {
    const left = x + (accent ? S.ACCENT_W : 0) + 4
    const name = fit(
      b.d.name,
      Math.max(0, x + w - 4 - left - 2 * S.CHIP_PAD),
      S.CHIP_SIZE,
      S.NAME_WEIGHT,
      measure
    )
    if (name) {
      const cy = y + (h - chipH) / 2
      out.push(
        el("rect", {
          x: left,
          y: cy,
          width: measure(name, S.CHIP_SIZE, S.NAME_WEIGHT) + 2 * S.CHIP_PAD,
          height: chipH,
          rx: 4,
          fill: PRINT.paper,
          stroke: PRINT.rule,
          "stroke-width": 0.75,
        }),
        text(name, {
          x: left + S.CHIP_PAD,
          y: baselineAt(cy, S.CHIP_SIZE, chipH),
          "font-size": S.CHIP_SIZE,
          "font-weight": S.NAME_WEIGHT,
          fill: PRINT.text,
        })
      )
    }
  }
  return out.join("")
}

/** A 0U lane: its strips sharing the lane's height, each with its name
 * running down it. */
function laneSvg(
  lane: Box,
  strips: readonly ElevationDevice[],
  measure: Measure
): string {
  const n = strips.length
  const h = (lane.h - (n - 1) * S.STRIP_GAP) / n
  return strips
    .map((d, i) => {
      const y = lane.y + i * (h + S.STRIP_GAP)
      const cx = lane.x + lane.w / 2
      const cy = y + h / 2
      const name = fit(d.name, Math.max(0, h - 8), S.STRIP_SIZE, 400, measure)
      return (
        el("rect", {
          x: lane.x + 0.5,
          y: y + 0.5,
          width: lane.w - 1,
          height: Math.max(0, h - 1),
          rx: S.STRIP_RADIUS,
          fill: INK.strip,
          stroke: PRINT.border,
          "stroke-width": 1,
        }) +
        (name
          ? text(name, {
              x: cx,
              y: baselineAt(cy - S.STRIP_SIZE, S.STRIP_SIZE, 2 * S.STRIP_SIZE),
              "text-anchor": "middle",
              transform: `rotate(90 ${fmt(cx)} ${fmt(cy)})`,
              "font-size": S.STRIP_SIZE,
              fill: PRINT.text,
            })
          : "")
      )
    })
    .join("")
}

function faceSvg(
  f: FaceLayout,
  rack: ElevationRack,
  rowH: number,
  look: ElevationLook,
  labels: boolean,
  photos: PhotoSymbols,
  prefix: string,
  measure: Measure
): string {
  const accent = hex6(rack.role?.color)
  const { frame, grid } = f
  const out: string[] = [
    text(f.face.toUpperCase(), {
      x: frame.x,
      y: baselineAt(frame.y - S.FACE_ROW, S.FACE_SIZE, S.FACE_ROW - 4),
      "font-size": S.FACE_SIZE,
      "font-weight": 600,
      "letter-spacing": 0.8,
      fill: PRINT.subtle,
    }),
    el("rect", {
      x: frame.x + 0.5,
      y: frame.y + 0.5,
      width: frame.w - 1,
      height: frame.h - 1,
      rx: S.FRAME_RADIUS,
      fill: PRINT.paper,
      stroke: PRINT.border,
      "stroke-width": 1,
    }),
    el("rect", {
      x: grid.x,
      y: grid.y,
      width: grid.w,
      height: grid.h,
      fill: INK.band,
    }),
  ]
  // The rules between units, and each unit's number beside the frame.
  const units = unitsTopDown(rack)
  const rules = units
    .slice(1)
    .map(
      (_, i) =>
        `M ${fmt(grid.x)},${fmt(grid.y + (i + 1) * rowH - 0.5)} H ${fmt(grid.x + grid.w)}`
    )
    .join(" ")
  if (rules)
    out.push(
      el("path", {
        d: rules,
        stroke: INK.rule,
        "stroke-width": 1,
        fill: "none",
      })
    )
  units.forEach((u, i) =>
    out.push(
      text(String(u), {
        x: f.ruler.right,
        y: baselineAt(grid.y + i * rowH, S.RULER_SIZE, rowH),
        "text-anchor": "end",
        "font-size": S.RULER_SIZE,
        fill: PRINT.subtle,
      })
    )
  )
  for (const b of f.blocks) {
    const href = look === "images" ? photoOf(b, f.face) : null
    if (b.hatched) out.push(hatchedBlock(b, measure))
    else if (href && photos.get(href))
      out.push(photoBlock(b, href, photos, accent, labels, measure))
    else out.push(namesBlock(b, accent, measure))
  }
  if (f.lanes.left) out.push(laneSvg(f.lanes.left, f.strips.left, measure))
  if (f.lanes.right) out.push(laneSvg(f.lanes.right, f.strips.right, measure))
  return `<g id="${prefix}${f.face}">${out.join("")}</g>`
}

/** The rack's elevation as an SVG string - deterministic: the same rack,
 * devices and options give the same file, byte for byte. */
export function rackSvg(
  rack: ElevationRack,
  devices: readonly ElevationDevice[],
  opts: RackSvgOptions = {}
): string {
  const measure = opts.measure ?? measureText
  const prefix = (opts.idPrefix ?? "rk-").replace(/[^A-Za-z0-9_-]/g, "")
  const look = opts.look ?? "names"
  const labels = opts.labels ?? true
  const photos = new PhotoSymbols(opts.photos ?? new Map(), prefix)
  const lay = layout(rack, devices, opts, measure)

  const body: string[] = []
  if (lay.heading)
    body.push(
      `<g id="${prefix}heading">` +
        text(lay.heading.title, {
          x: S.MARGIN,
          y: S.MARGIN + S.TITLE_SIZE,
          "font-size": S.TITLE_SIZE,
          "font-weight": 700,
          fill: PRINT.text,
        }) +
        (lay.heading.facts
          ? text(lay.heading.facts, {
              x: S.MARGIN,
              y: S.MARGIN + S.TITLE_SIZE + 6 + S.FACTS_SIZE,
              "font-size": S.FACTS_SIZE,
              fill: PRINT.muted,
            })
          : "") +
        `</g>`
    )
  for (const f of lay.faces)
    body.push(faceSvg(f, rack, lay.rowH, look, labels, photos, prefix, measure))

  const faceNames = lay.faces.map((f) => f.face).join(" and ")
  return svgDocument({
    width: lay.width,
    height: lay.height,
    title: `${rack.name} elevation`,
    desc: [
      `${faceNames[0].toUpperCase()}${faceNames.slice(1)}`,
      look === "images" ? "Images" : "Names",
      `${rack.u_height} U`,
    ].join(" · "),
    defs: photos.defs(),
    embedFont: opts.embedFont,
    body,
  })
}
