import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
} from "@/lib/api"
import { getLucideIcon } from "@/components/dynamic-icon"
import { attrs as markupAttrs, el, esc, text } from "@/lib/diagram/markup"
import { PAPERS, SHEET } from "@/lib/diagram/sheet"
import type { PaperChoice } from "@/lib/diagram/sheet"
import {
  WALL_THICKNESS_M,
  wallDoorSpans,
  wallSegmentsWithOpenings,
} from "@/components/floorplan3d/world"

import {
  PATTERN_GAP,
  PATTERN_STROKE,
  labelColor,
  areaColor,
  areaIcon,
  areaLabelColor,
  areaName,
  areaNameHalo,
  areaPattern,
  patternRuns,
  boxCenter,
  byZ,
  labelBox,
  labelFontCells,
  labelPlate,
  opensName,
  polygonCentroid,
  shapeBounds,
  tileBox,
  tileQuarter,
} from "./shapes"
import type { AreaShape, LabelShape, PlanShape } from "./shapes"
import {
  CABLE_LINE,
  CABLE_NONE_PAPER,
  bundleWidth,
  bundledGroups,
  cableColor,
  drawnRouteState,
  laneOrder,
  lanePolylines,
  layoutCables,
  paperLod,
  roundedPath,
  sharedColor,
  STUB_MM,
  endText,
  typePalette,
} from "./cable-draw"
import type { CableColorBy, CableRoute, CableStub } from "./cable-draw"
import type { Pt } from "./cable-route"
import { layoutPlanLabels } from "./plan-label-pass"
import type { AlongLabel, PlanLabels } from "./plan-label-pass"
import {
  CHIP_FONT_MM,
  LABEL_FONT_MM,
  LABEL_REPEAT_MM,
  textSize,
} from "./plan-labels"
import {
  READABLE_FONT_MM,
  READABLE_SHORT_MM,
  READABLE_SYMBOL_MM,
  READABLE_TRAY_MM,
  fontGrow,
  growStubs,
  readableShape,
} from "./readable"
import type { CellBox, ObjectSize } from "./readable"
import { rackFigures, tileFill, tilePaint } from "./tile-paint"
import type { ColorBy, RackFigures } from "./tile-paint"

// The 2D plan as a standalone, light-themed SVG for the PDF export
// (api/floor_plan_pdf.py): raised floors, zones, tiles with their labels and
// figures, walls with their doors, and trays - drawn as the canvas draws
// them (floor-canvas.tsx), in plan pixels (CELL per cell), with fixed colours
// instead of the theme's classes. The server lays the plan's CAD drawing
// under it and writes the sheet around it; nothing here is trusted there
// beyond what its sanitiser keeps.

/** floor-canvas.tsx's CELL and GUTTER - kept equal so the two agree. */
const CELL = 40
const GUTTER = 2
/** The light theme's foreground: labels, figures and default-colour walls. */
export const PAPER_INK = "#18181b"
const TRAY_DEFAULT = "#71717a"
/** The light theme's muted text: a cable's length after its name. */
const MUTED_INK = "#71717a"
const AREA_DEFAULT = "#71717a"

export interface PlanSvgInput {
  plan: Pick<FloorPlan, "grid_width" | "grid_height" | "cell_mm"> &
    Partial<Pick<FloorPlan, "layout_mode">>
  /** The tiles as shown - hidden ones already left out. */
  tiles: FloorPlanTile[]
  walls?: FloorPlanWall[]
  trays?: FloorPlanTray[]
  areas?: {
    x: number
    y: number
    width: number
    height: number
    label: string
    color: string
    plenum_mm: number
  }[]
  /** Rooms, areas and labels as shown - hidden ones already left out. */
  shapes?: PlanShape[]
  colorBy?: ColorBy
  figures?: ReadonlyMap<string, RackFigures>
  liveState?: FloorPlanLiveState | null
  showZoneLabels?: boolean
  showTrays?: boolean
  /** The cables, drawn as the canvas draws them at the paper's scale. */
  cables?: PlanSvgCables
  /** Frame the drawing to what is on the plan (plus a margin) instead of
   * the whole grid, scaled for `paper`: a thumbnail of a big site plan.
   * `box` (plan px) frames it there instead and `mmPerPx` draws it for
   * that paper scale - a cable schedule close-up, as
   * `cable-schedule/closeups/` lays it out; only what reaches the box is
   * drawn. Inferred cable runs are dashed. */
  fitContent?: { paper: PaperChoice; mmPerPx?: number; box?: PlanBox }
  /** Readable (Display > Object size): objects never under
   * READABLE_SYMBOL_MM on paper, names at READABLE_FONT_MM, thinned where
   * they would overlap - at the paper's scale. */
  objectSize?: ObjectSize
  /** Paper mm per plan px of the sheet (planPaperScale) when the drawing
   * is not framed to its content; A3 landscape otherwise. */
  mmPerPx?: number
}

/** A rectangle in plan px. */
export interface PlanBox {
  x: number
  y: number
  w: number
  h: number
}

/** Margin round the content when the drawing is framed to it (cells). */
const FIT_MARGIN_CELLS = 2
/** Hatch lines on paper: this far apart and at least this wide (mm). */
const PAPER_PATTERN_GAP_MM = 2.5
const PAPER_PATTERN_STROKE_MM = 0.25

/** The plan px box round everything drawn - tiles, shapes, walls, trays -
 * with a margin, clamped to the grid; null for an empty plan. */
function contentBox(
  plan: Pick<FloorPlan, "grid_width" | "grid_height" | "cell_mm">,
  tiles: readonly FloorPlanTile[],
  shapes: readonly PlanShape[],
  walls: readonly { points: readonly (readonly number[])[] }[],
  trays: readonly { points: readonly (readonly number[])[] }[]
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const t of tiles) {
    add(t.x, t.y)
    add(t.x + t.width, t.y + t.height)
  }
  for (const sh of shapes) {
    const b = shapeBounds(sh, plan.cell_mm)
    add(b.minX, b.minY)
    add(b.maxX, b.maxY)
  }
  for (const run of [...walls, ...trays])
    for (const [x, y] of run.points) add(x, y)
  if (!Number.isFinite(minX)) return null
  const m = FIT_MARGIN_CELLS
  const x0 = Math.max(0, minX - m)
  const y0 = Math.max(0, minY - m)
  const x1 = Math.min(plan.grid_width, maxX + m)
  const y1 = Math.min(plan.grid_height, maxY + m)
  return {
    x: x0 * CELL,
    y: y0 * CELL,
    w: Math.max(CELL, (x1 - x0) * CELL),
    h: Math.max(CELL, (y1 - y0) * CELL),
  }
}

/** The cables for the drawing: the runs, their routes (use-cable-routes.ts)
 * and how the plan shows them. */
export interface PlanSvgCables {
  paths: readonly FloorPlanCablePath[]
  routes: ReadonlyMap<string, CableRoute>
  colorBy: CableColorBy
  bundle: boolean
  labels: boolean
  /** Traced runs: a static heavier stroke (no animation on paper). */
  highlight?: readonly string[]
  /** Paper mm per plan px (planPaperScale). */
  mmPerPx: number
  /** Cables with one end on the plan (cableStubs): a short dashed stub
   * with an arrow off the plan, and the far end's name when labels are
   * on. The overview only. */
  stubs?: readonly CableStub[]
  /** Inferred runs dashed, to tell them from documented ones on paper. */
  inferredDash?: boolean
}

/** An inferred run's dash on paper, in canvas px (as CABLE_LINE's). */
const INFERRED_PAPER_DASH = "5 3"

/** api/floor_plan_pdf.py's footer under the plan (mm). */
const PDF_FOOTER_MM = 22
const PDF_GAP_MM = 4

/** Paper mm per plan px when the PDF fits the plan to `paper` with its
 * title block - floor_plan_pdf.py's plan_sheet. */
export function planPaperScale(
  plan: Pick<FloorPlan, "grid_width" | "grid_height">,
  paper: PaperChoice = { size: "a3", orientation: "landscape" }
): number {
  let [pw, ph] = PAPERS[paper.size]
  if (paper.orientation === "portrait") [pw, ph] = [ph, pw]
  const aw = pw - 2 * SHEET.MARGIN
  const ah = ph - 2 * SHEET.MARGIN - PDF_FOOTER_MM - PDF_GAP_MM
  const w = Math.max(plan.grid_width * CELL, 1)
  const h = Math.max(plan.grid_height * CELL, 1)
  return Math.min(aw / w, ah / h)
}

/** One screen px of the canvas's strokes, on paper (mm). */
const MM_PER_SCREEN_PX = 0.18
/** Lanes closer than this on paper merge into a bundle (mm). */
const PAPER_LANE_MIN_MM = 0.6

/** The cables at the paper's scale: lanes, bundles with their counts, the
 * colours and line styles of the canvas. Inferred runs stay thin and
 * light; traced runs are a heavier stroke. No preview or stale marks.
 * Their names are the label pass's (labelsMarkup). */
function paperCables(c: PlanSvgCables) {
  const layout = layoutCables(c.routes, laneOrder(c.paths, c.routes))
  const mmPerCell = CELL * c.mmPerPx
  const lod = paperLod(mmPerCell)
  const bundled = bundledGroups(layout, {
    lod,
    bundle: c.bundle,
    minGapCells: PAPER_LANE_MIN_MM / mmPerCell,
  })
  return { layout, lod, bundled }
}

/** The cables' runs on paper: lanes, bundles, stubs. */
function cablesMarkup(c: PlanSvgCables): string {
  const routes = c.routes
  const byId = new Map(c.paths.map((cp) => [cp.id, cp]))
  const palette = typePalette(c.paths)
  const { layout, bundled } = paperCables(c)
  const hi = new Set(c.highlight ?? [])
  const w = (screenPx: number) => (screenPx * MM_PER_SCREEN_PX) / c.mmPerPx
  const fontPx = LABEL_FONT_MM / c.mmPerPx
  const colorOf = (id: string) => {
    const cp = byId.get(id)
    return (cp && cableColor(cp, c.colorBy, palette)) || CABLE_NONE_PAPER
  }
  const toPx = (pts: readonly Pt[]): Pt[] =>
    pts.map(([x, y]) => [x * CELL, y * CELL])
  const parts: string[] = []
  for (const key of bundled) {
    const g = layout.groups.get(key)!
    const color =
      sharedColor(
        g.members.map((id) => {
          const cp = byId.get(id)
          return cp ? cableColor(cp, c.colorBy, palette) : null
        })
      ) ?? CABLE_NONE_PAPER
    parts.push(
      el("path", {
        d: roundedPath(toPx([g.a, g.b]), 0),
        fill: "none",
        stroke: color,
        "stroke-opacity": 0.85,
        "stroke-width": w(bundleWidth(g.members.length)),
        "stroke-linecap": "round",
      })
    )
  }
  const lines = (id: string, traced: boolean) => {
    const cp = byId.get(id)
    const state = cp ? drawnRouteState(cp, routes.get(id)) : "inferred"
    const style =
      state === "inferred" && c.inferredDash
        ? { ...CABLE_LINE.inferred, dash: INFERRED_PAPER_DASH }
        : CABLE_LINE[state]
    const segs = layout.cables.get(id)!
    const polys = traced
      ? lanePolylines(segs)
      : lanePolylines(segs, (s) => !!s.group && bundled.has(s.group))
    const color = colorOf(id)
    return polys
      .map((poly) =>
        el("path", {
          d: roundedPath(toPx(poly), 6),
          fill: "none",
          stroke: color,
          "stroke-opacity": traced ? 1 : style.opacity,
          "stroke-width": w(style.width + (traced ? 2 : 0)),
          "stroke-dasharray": style.dash
            ? style.dash
                .split(" ")
                .map((n) => +(w(Number(n)) || 0).toFixed(2))
                .join(" ")
            : undefined,
          "stroke-linecap": style.cap,
          "stroke-linejoin": "round",
        })
      )
      .join("")
  }
  // A white casing under every run first, so a run reads over a CAD
  // drawing or a busy floor while a tray's lanes stay side by side.
  for (const id of layout.order) {
    if (hi.has(id)) continue
    const cp = byId.get(id)
    const style =
      CABLE_LINE[cp ? drawnRouteState(cp, routes.get(id)) : "inferred"]
    for (const poly of lanePolylines(
      layout.cables.get(id)!,
      (s) => !!s.group && bundled.has(s.group)
    ))
      parts.push(
        el("path", {
          d: roundedPath(toPx(poly), 6),
          fill: "none",
          stroke: "#ffffff",
          "stroke-opacity": 0.85,
          "stroke-width": w(style.width + 1.2),
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        })
      )
  }
  for (const id of layout.order) if (!hi.has(id)) parts.push(lines(id, false))
  for (const id of c.highlight ?? [])
    if (layout.cables.has(id)) parts.push(lines(id, true))
  /** A stub on paper: STUB_MM of dashed line out of its tile in the
   * cable's colour, an arrow at its end, the far end's name beyond it. */
  function stubMarkup(st: CableStub): string {
    const color = colorOf(st.id)
    const len = STUB_MM / c.mmPerPx
    const ah = 1 / c.mmPerPx
    const x0 = st.from[0] * CELL
    const y0 = st.from[1] * CELL
    const x1 = x0 + st.dir[0] * len
    const y1 = y0 + st.dir[1] * len
    const nx = -st.dir[1]
    const ny = st.dir[0]
    const r = (n: number) => +n.toFixed(2)
    let out =
      el("path", {
        d: `M${r(x0)},${r(y0)}L${r(x1)},${r(y1)}`,
        fill: "none",
        stroke: color,
        "stroke-width": w(2),
        "stroke-dasharray": `${r(w(4))} ${r(w(3))}`,
        "data-stub": st.id,
      }) +
      el("path", {
        d:
          `M${r(x1 + st.dir[0] * ah)},${r(y1 + st.dir[1] * ah)}` +
          `L${r(x1 + nx * ah)},${r(y1 + ny * ah)}` +
          `L${r(x1 - nx * ah)},${r(y1 - ny * ah)}Z`,
        fill: color,
      })
    if (c.labels && st.far.length) {
      const name = endText(st.far)
      out += text(name.length > 28 ? `${name.slice(0, 27)}…` : name, {
        x: r(x1 + st.dir[0] * ah * 2),
        y: r(y1 + st.dir[1] * ah * 2 + fontPx * 0.35),
        "text-anchor":
          st.dir[0] < -0.3 ? "end" : st.dir[0] > 0.3 ? "start" : "middle",
        "font-size": fontPx,
        fill: PAPER_INK,
      })
    }
    return out
  }
  for (const st of c.stubs ?? []) parts.push(stubMarkup(st))
  return `<g data-layer="cables">${parts.join("")}</g>`
}

/** An area type's icon as SVG markup, `size` px square at (x, y), stroked
 * in `color`; "" for no icon or a name Lucide does not know. */
function iconMarkup(
  name: string,
  x: number,
  y: number,
  size: number,
  color: string
): string {
  const Icon = name ? getLucideIcon(name) : null
  if (!Icon) return ""
  // Lucide's own classes mean nothing on paper (no theme classes here).
  return renderToStaticMarkup(
    createElement(Icon, {
      x,
      y,
      width: size,
      height: size,
      color,
      strokeWidth: 2.25,
    })
  ).replace(/\sclass="[^"]*"/g, "")
}

/** An area type's pattern as strokes clipped to the area (`clip`: its
 * outline's markup) - plain lines and a clip path, which the PDF's
 * sanitiser keeps (it drops `<pattern>`). */
function patternMarkup(
  a: AreaShape,
  color: string,
  clip: string,
  box: { x: number; y: number; w: number; h: number },
  pat: PatternScale = DEFAULT_PATTERN
): string {
  const runs = patternRuns(areaPattern(a), box.x, box.y, box.w, box.h, {
    gap: pat.gap,
  })
  if (!runs.length) return ""
  const id = `ap-${a.id}`.replace(/[^A-Za-z0-9_.-]/g, "_")
  const body = runs
    .map(
      (run) =>
        `<g${run.dash ? ` stroke-dasharray="${run.dash}"` : ""}>` +
        run.lines
          .map(([x1, y1, x2, y2]) => el("line", { x1, y1, x2, y2 }))
          .join("") +
        "</g>"
    )
    .join("")
  return (
    `<clipPath id="${id}">${clip}</clipPath>` +
    `<g clip-path="url(#${id})" stroke="${color}" ` +
    `stroke-opacity="${PATTERN_STROKE.opacity}" ` +
    `stroke-width="${pat.width}">${body}</g>`
  )
}

/** An area's name with its type's icon before it, as the canvas draws it:
 * from its top left (`start`, y the baseline) or centred on x. A patterned
 * area's name sits on a white halo (a stroked copy under it). */
function areaNameMarkup(
  a: AreaShape,
  name: string,
  x: number,
  y: number,
  anchor: "start" | "middle",
  ink: string,
  grow = 1
): string {
  const icon = getLucideIcon(areaIcon(a)) ? areaIcon(a) : ""
  const shift = icon ? 16 * grow : 0
  const textW = name.length * 12 * grow * 0.6
  const tx = anchor === "middle" ? x + shift / 2 : x + shift
  const ix = anchor === "middle" ? x - (shift + textW) / 2 : x
  const font = {
    x: tx,
    y,
    "text-anchor": anchor === "middle" ? "middle" : undefined,
    "font-size": 12 * grow,
    "font-weight": 600,
  }
  return (
    (icon ? iconMarkup(icon, ix, y - 10.5 * grow, 12 * grow, ink) : "") +
    (areaNameHalo(a) || grow > 1
      ? text(name, {
          ...font,
          fill: "#ffffff",
          stroke: "#ffffff",
          "stroke-width": 3 * grow,
          "stroke-linejoin": "round",
        })
      : "") +
    text(name, { ...font, fill: ink })
  )
}

/** An area as the canvas draws it (shape-layer.tsx). */
/** Hatch spacing and line width in plan px. */
interface PatternScale {
  gap: number
  width: number
}
const DEFAULT_PATTERN: PatternScale = {
  gap: PATTERN_GAP,
  width: PATTERN_STROKE.width,
}

function areaMarkup(
  a: AreaShape,
  pat: PatternScale = DEFAULT_PATTERN,
  grow = 1,
  nameAt?: Pt | null
): string {
  const color = areaColor(a)
  const ink = areaLabelColor(a)
  const name = a.show_name && nameAt !== null ? areaName(a) : ""
  const style = {
    fill: color,
    "fill-opacity": a.fill_opacity / 100,
    stroke: color,
    "stroke-opacity": a.border === "none" ? 0 : 0.6,
    "stroke-width": 1.5,
    "stroke-dasharray": a.border === "dashed" ? "8 5" : undefined,
  }
  if (a.shape === "polygon") {
    if (a.points.length < 3) return ""
    const [cx, cy] = polygonCentroid(a.points)
    const points = a.points.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
    const xs = a.points.map((p) => p[0] * CELL)
    const ys = a.points.map((p) => p[1] * CELL)
    const bx = Math.min(...xs)
    const by = Math.min(...ys)
    return (
      el("polygon", { points, "stroke-linejoin": "round", ...style }) +
      patternMarkup(
        a,
        color,
        el("polygon", { points }),
        {
          x: bx,
          y: by,
          w: Math.max(...xs) - bx,
          h: Math.max(...ys) - by,
        },
        pat
      ) +
      (name
        ? areaNameMarkup(
            a,
            name,
            cx * CELL,
            cy * CELL + 4 * grow,
            "middle",
            ink,
            grow
          )
        : "")
    )
  }
  const [cx, cy] = boxCenter(a)
  const box = {
    x: a.x * CELL,
    y: a.y * CELL,
    w: a.width * CELL,
    h: a.height * CELL,
  }
  return (
    `<g${a.rotation ? ` transform="rotate(${a.rotation},${cx * CELL},${cy * CELL})"` : ""}>` +
    el("rect", {
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      rx: 3,
      ...style,
    }) +
    patternMarkup(
      a,
      color,
      el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: 3 }),
      box,
      pat
    ) +
    (name
      ? areaNameMarkup(
          a,
          name,
          nameAt ? nameAt[0] * CELL : box.x + 6 * grow,
          nameAt ? nameAt[1] * CELL + 12 * grow * 0.8 : box.y + 15 * grow,
          "start",
          ink,
          grow
        )
      : "") +
    "</g>"
  )
}

/** Where an area or label opens, as a note under it on paper ("→ B1"):
 * the export cannot be clicked. */
function opensNoteMarkup(s: PlanShape, cellMm: number): string {
  const name = opensName(s)
  if (!name) return ""
  const b = shapeBounds(s, cellMm)
  return text(`→ ${name}`, {
    x: b.minX * CELL + 2,
    y: b.maxY * CELL + 11,
    "font-size": 9,
    fill: "#71717a",
  })
}

/** A label at its real size, in its paper ink. */
function labelMarkup(
  l: LabelShape,
  cellMm: number,
  mmPerPx: number | null = null
): string {
  const box = labelBox(l, cellMm)
  const [cx, cy] = boxCenter(box)
  const size = labelFontCells(l.font_mm, cellMm) * CELL
  // Readable: the label, plate and all, grown about its centre.
  const grow = mmPerPx == null ? 1 : fontGrow(size, mmPerPx, READABLE_FONT_MM)
  const turns = [
    l.rotation ? `rotate(${l.rotation},${cx * CELL},${cy * CELL})` : "",
    grow > 1
      ? `translate(${cx * CELL},${cy * CELL}) scale(${+grow.toFixed(4)}) translate(${-cx * CELL},${-cy * CELL})`
      : "",
  ]
    .filter(Boolean)
    .join(" ")
  const anchor =
    l.align === "center" ? "middle" : l.align === "right" ? "end" : "start"
  const tx =
    l.align === "center"
      ? (box.x + box.width / 2) * CELL
      : l.align === "right"
        ? (box.x + box.width) * CELL - size * 0.3
        : box.x * CELL + size * 0.3
  const plate = labelPlate(l)
  const ink = plate.ink ?? labelColor(l.color).paper
  const lines = l.text
    .split("\n")
    .map((line, i) =>
      text(line || " ", {
        x: tx,
        y: box.y * CELL + size * 0.15 + size * (i * 1.25 + 1),
        "text-anchor": anchor,
        "font-size": size,
        "font-weight": l.weight === "bold" ? 700 : 400,
        fill: ink,
      })
    )
    .join("")
  return (
    `<g${turns ? ` transform="${turns}"` : ""}>` +
    (l.plate
      ? el("rect", {
          x: box.x * CELL,
          y: box.y * CELL,
          width: box.width * CELL,
          height: box.height * CELL,
          rx: Math.min(6, size * 0.2),
          fill: plate.fill ?? "#ffffff",
          stroke: "#e4e4e7",
          "stroke-width": 1,
        })
      : "") +
    lines +
    "</g>"
  )
}

const tileName = (t: FloorPlanTile) => t.label || t.linked?.name || ""

function clip(name: string, w: number, size: number): string {
  const max = Math.max(3, Math.floor(w / (size * 0.62)))
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

function zoneMarkup(t: FloorPlanTile, showLabel: boolean, grow = 1): string {
  const w = t.width * CELL
  const h = t.height * CELL
  const fill = tileFill(t)
  const name = tileName(t)
  return (
    `<g transform="translate(${t.x * CELL},${t.y * CELL})">` +
    el("rect", {
      width: w,
      height: h,
      rx: 4,
      fill,
      "fill-opacity": 0.14,
      stroke: fill,
      "stroke-opacity": 0.35,
      "stroke-width": 1,
      "stroke-dasharray": "4 4",
    }) +
    (showLabel && name
      ? text(grow > 1 ? name : clip(name, w - 12, 10), {
          x: 6 * grow,
          y: 14 * grow,
          "font-size": 10 * grow,
          "font-weight": 500,
          fill,
        })
      : "") +
    "</g>"
  )
}

function facingBar(w: number, h: number, orientation: number) {
  const t = 3
  const edge = 1.5
  const inset = 7
  if (orientation === 90)
    return { x: w - edge - t, y: inset, width: t, height: h - inset * 2 }
  if (orientation === 180)
    return { x: inset, y: h - edge - t, width: w - inset * 2, height: t }
  if (orientation === 270)
    return { x: edge, y: inset, width: t, height: h - inset * 2 }
  return { x: inset, y: edge, width: w - inset * 2, height: t }
}

function tileMarkup(
  t: FloorPlanTile,
  colorBy: ColorBy,
  figures: RackFigures | undefined,
  live: FloorPlanLiveState["tiles"][string] | undefined,
  hideName = false
): string {
  const w = t.width * CELL
  const h = t.height * CELL
  const rackLive = live?.kind === "rack" ? live : null
  const paint = tilePaint({
    tile: t,
    colorBy,
    rack: figures ?? rackFigures(null, rackLive),
    check: live?.check ?? null,
  })
  const dashed = t.status === "planned" || t.status === "reserved"
  const iw = w - GUTTER * 2
  const ih = h - GUTTER * 2
  const parts: string[] = []
  parts.push(
    el("rect", {
      x: GUTTER,
      y: GUTTER,
      width: iw,
      height: ih,
      rx: 5,
      fill: paint.fill,
      "fill-opacity": paint.fillOpacity,
      stroke: paint.stroke,
      "stroke-opacity": paint.strokeOpacity,
      "stroke-width": paint.strokeWidth,
      "stroke-dasharray": dashed ? "6 3" : undefined,
    })
  )
  const bar = facingBar(iw, ih, t.orientation)
  parts.push(
    el("rect", {
      x: bar.x + GUTTER,
      y: bar.y + GUTTER,
      width: bar.width,
      height: bar.height,
      rx: 1.5,
      fill: paint.fill,
      opacity: 0.9,
    })
  )
  const figure = paint.figure
  const wide = w >= CELL * 2
  const figureText = figure && (wide || figure.always) ? figure.text : null
  const stacked = !!figureText && (!wide || (!!figure?.always && h < CELL * 2))
  const name = hideName ? "" : tileName(t)
  if (name) {
    const room = stacked ? h - 14 : h
    const size = stacked ? Math.min(11, room * 0.45) : 11
    const y = stacked ? (h - 14) / 2 + size / 3 : h / 2 + size / 3
    parts.push(
      text(clip(name, w - 8, size), {
        x: w / 2,
        y,
        "text-anchor": "middle",
        "font-size": size,
        fill: PAPER_INK,
        opacity: paint.muted ? 0.6 : 1,
      })
    )
  }
  if (figure) {
    const bw = w - GUTTER * 2 - 6
    parts.push(
      el("rect", {
        x: GUTTER + 3,
        y: h - GUTTER - 7,
        width: bw,
        height: 4,
        rx: 2,
        fill: PAPER_INK,
        "fill-opacity": 0.1,
      })
    )
    if (figure.ratio != null)
      parts.push(
        el("rect", {
          x: GUTTER + 3,
          y: h - GUTTER - 7,
          width: Math.max(2, bw * Math.min(1, figure.ratio)),
          height: 4,
          rx: 2,
          fill: figure.color,
        })
      )
    if (figureText)
      parts.push(
        text(figureText, {
          x: wide ? w - GUTTER - 4 : w / 2,
          y: h - GUTTER - 10,
          "text-anchor": wide ? "end" : "middle",
          "font-size": 8,
          fill: PAPER_INK,
          opacity: figure.always ? 0.85 : 0.7,
        })
      )
  }
  return (
    `<g transform="translate(${t.x * CELL},${t.y * CELL})"` +
    (paint.opacity !== 1 ? ` opacity="${paint.opacity}"` : "") +
    `>${parts.join("")}</g>`
  )
}

function wallMarkup(wall: FloorPlanWall, cellMm: number): string {
  if (wall.points.length < 2) return ""
  const color = wall.color || PAPER_INK
  const px = Math.max(
    3.5,
    ((wall.thickness_mm ?? WALL_THICKNESS_M * 1000) * CELL) / cellMm
  )
  const solids = wallSegmentsWithOpenings(wall.points, wall.openings, 1).filter(
    (b) => b.y0 === 0
  )
  const parts = solids.map((b) =>
    el("line", {
      x1: b.x0 * CELL,
      y1: b.z0 * CELL,
      x2: b.x1 * CELL,
      y2: b.z1 * CELL,
      stroke: color,
      "stroke-opacity": 0.85,
      "stroke-width": px,
      "stroke-linecap": "square",
    })
  )
  for (const d of wallDoorSpans(wall.points, wall.openings)) {
    const x0 = d.x0 * CELL
    const y0 = d.z0 * CELL
    const x1 = d.x1 * CELL
    const y1 = d.z1 * CELL
    const len = Math.hypot(x1 - x0, y1 - y0) || 1
    const nx = -(y1 - y0) / len
    const ny = (x1 - x0) / len
    const hh = px / 2 + 2
    parts.push(
      el("line", {
        x1: x0,
        y1: y0,
        x2: x1,
        y2: y1,
        stroke: color,
        "stroke-opacity": 0.5,
        "stroke-width": 1.5,
        "stroke-dasharray": "3 3",
      }),
      el("line", {
        x1: x0 - nx * hh,
        y1: y0 - ny * hh,
        x2: x0 + nx * hh,
        y2: y0 + ny * hh,
        stroke: color,
        "stroke-opacity": 0.85,
        "stroke-width": 1.5,
      }),
      el("line", {
        x1: x1 - nx * hh,
        y1: y1 - ny * hh,
        x2: x1 + nx * hh,
        y2: y1 + ny * hh,
        stroke: color,
        "stroke-opacity": 0.85,
        "stroke-width": 1.5,
      })
    )
  }
  return `<g>${parts.join("")}</g>`
}

function trayMarkup(
  tray: FloorPlanTray,
  mmPerPx: number | null = null,
  hideName = false
): string {
  if (tray.points.length < 2) return ""
  const color = tray.color || TRAY_DEFAULT
  const pts = tray.points.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
  const mid = tray.points[Math.floor(tray.points.length / 2)]
  // Readable: at least READABLE_TRAY_MM wide on paper, the name and its
  // cable count at least READABLE_FONT_MM.
  const width = mmPerPx == null ? 10 : Math.max(10, READABLE_TRAY_MM / mmPerPx)
  const grow = mmPerPx == null ? 1 : fontGrow(9, mmPerPx, READABLE_FONT_MM)
  const count = mmPerPx == null ? 0 : tray.cables.length
  const hidden = mmPerPx == null ? 0 : (tray.hidden_cable_count ?? 0)
  const label =
    tray.name +
    (count > 0 ? ` · ${count}` : "") +
    (hidden > 0 ? ` · ${hidden} hidden` : "")
  const at = {
    x: mid[0] * CELL + 8 * grow,
    y: mid[1] * CELL - Math.max(8 * grow, width / 2 + 3 * grow),
    "font-size": +(9 * grow).toFixed(2),
  }
  return (
    // A casing round the channel, as a road is drawn on a map.
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": +(width + (mmPerPx == null ? 3 : 0.4 / mmPerPx)).toFixed(
        2
      ),
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      "data-part": "casing",
    }) +
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: color,
      "stroke-opacity": 0.4,
      "stroke-width": +width.toFixed(2),
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }) +
    (tray.name && !hideName
      ? (grow > 1
          ? text(label, {
              ...at,
              fill: "#ffffff",
              stroke: "#ffffff",
              "stroke-width": +(3 * grow).toFixed(2),
              "stroke-linejoin": "round",
            })
          : "") + text(label, { ...at, fill: color })
      : "")
  )
}

/** The label pass's texts on paper (plan-label-pass.ts), at `mmPerPx`:
 * trays' names along the trays, bundle counts and cable names along the
 * runs, the traced cables' ends in chips, the grown tiles' names - each on
 * a white halo (a second text under it: the sanitiser keeps no
 * paint-order). */
function labelsMarkup(
  labels: PlanLabels,
  mmPerPx: number,
  trays: readonly FloorPlanTray[]
): string {
  const r = (n: number) => +n.toFixed(2)
  const font = r(LABEL_FONT_MM / mmPerPx)
  const halo = r(font * 0.27)
  const color = new Map(trays.map((t) => [t.id, t.color || TRAY_DEFAULT]))
  const along = (l: AlongLabel, fill: string, weight: number) => {
    const attrs = {
      transform: `translate(${r(l.at[0] * CELL)},${r(l.at[1] * CELL)})${l.angle ? ` rotate(${r(l.angle)})` : ""}`,
      y: r(font * 0.35),
      "text-anchor": "middle",
      "font-size": font,
      "font-weight": weight,
    }
    const body = l.suffix
      ? `${esc(l.text)}<tspan fill="${MUTED_INK}">${esc(l.suffix)}</tspan>`
      : esc(l.text)
    return (
      text(l.text + (l.suffix ?? ""), {
        ...attrs,
        fill: "#ffffff",
        stroke: "#ffffff",
        "stroke-width": halo,
        "stroke-linejoin": "round",
      }) + `<text${markupAttrs({ ...attrs, fill })}>${body}</text>`
    )
  }
  const parts: string[] = []
  for (const l of labels.trays)
    parts.push(along(l, color.get(l.id) ?? TRAY_DEFAULT, 600))
  for (const l of labels.bundles) parts.push(along(l, PAPER_INK, 600))
  for (const l of labels.cables) parts.push(along(l, PAPER_INK, 500))
  const chipFont = r(CHIP_FONT_MM / mmPerPx)
  for (const l of labels.ends) {
    const { w, h } = textSize(l.text, chipFont)
    const x = l.at[0] * CELL
    const y = l.at[1] * CELL
    parts.push(
      el("rect", {
        x: r(x - w / 2),
        y: r(y - h / 2),
        width: r(w),
        height: r(h),
        rx: r(h * 0.2),
        fill: "#ffffff",
        stroke: "#d4d4d8",
        "stroke-width": r(0.15 / mmPerPx),
      }) +
        text(l.text, {
          x: r(x),
          y: r(y + chipFont * 0.35),
          "text-anchor": "middle",
          "font-size": chipFont,
          fill: PAPER_INK,
        })
    )
  }
  const names = labels.tiles.map((l) => {
    const attrs = {
      x: r(l.at[0] * CELL),
      y: r(l.at[1] * CELL + font * 0.35),
      "text-anchor": "middle",
      "font-size": font,
      "font-weight": 500,
    }
    return (
      text(l.text, {
        ...attrs,
        fill: "#ffffff",
        stroke: "#ffffff",
        "stroke-width": halo,
        "stroke-linejoin": "round",
      }) + text(l.text, { ...attrs, fill: PAPER_INK })
    )
  })
  return (
    (parts.length ? `<g data-layer="plan-labels">${parts.join("")}</g>` : "") +
    (names.length ? `<g data-layer="readable-names">${names.join("")}</g>` : "")
  )
}

/** A tile too thin, or a photo too small, to read on paper: its symbol -
 * a rounded box in its colour at the drawn size (`box`, cells). */
function symbolMarkup(t: FloorPlanTile, box: CellBox): string {
  const r = (n: number) => +n.toFixed(2)
  const w = box.w * CELL
  const h = box.h * CELL
  return el("rect", {
    x: r(box.x * CELL),
    y: r(box.y * CELL),
    width: r(w),
    height: r(h),
    rx: r(Math.min(w, h) * 0.2),
    fill: tileFill(t),
    "fill-opacity": 0.9,
    stroke: tileFill(t),
    "data-symbol": t.id,
  })
}

/** The plan as SVG markup, `viewBox="0 0 W H"` in plan pixels. */
export function planSvg({
  plan,
  tiles,
  walls = [],
  trays = [],
  areas = [],
  shapes = [],
  colorBy = "type",
  figures,
  liveState,
  showZoneLabels = true,
  showTrays = true,
  cables,
  fitContent,
  objectSize = "real",
  mmPerPx: sheetMmPerPx,
}: PlanSvgInput): string {
  const w = plan.grid_width * CELL
  const h = plan.grid_height * CELL
  // Framed to the content: the view box, and the paper scale it gives, so
  // hatches and cables are drawn for the paper and not for the full grid.
  const frame = fitContent
    ? (fitContent.box ?? contentBox(plan, tiles, shapes, walls, trays))
    : null
  // A close-up draws only what reaches its box: twenty of them post less.
  const closeBox = fitContent?.box
  if (closeBox) {
    const near = (x0: number, y0: number, x1: number, y1: number) =>
      x0 * CELL <= closeBox.x + closeBox.w &&
      x1 * CELL >= closeBox.x &&
      y0 * CELL <= closeBox.y + closeBox.h &&
      y1 * CELL >= closeBox.y
    const runNear = (pts: readonly (readonly number[])[]) =>
      pts.length > 0 &&
      near(
        Math.min(...pts.map((p) => p[0])),
        Math.min(...pts.map((p) => p[1])),
        Math.max(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1]))
      )
    tiles = tiles.filter((t) => {
      // Generous: a turned tile reaches past its own box.
      const r = Math.max(t.width, t.height)
      return near(t.x - r, t.y - r, t.x + t.width + r, t.y + t.height + r)
    })
    shapes = shapes.filter((sh) => {
      const b = shapeBounds(sh, plan.cell_mm)
      // A label's note sits under it.
      return near(b.minX, b.minY, b.maxX, b.maxY + 1)
    })
    walls = walls.filter((wall) => runNear(wall.points))
    trays = trays.filter((tray) => runNear(tray.points))
    areas = areas.filter((a) => near(a.x, a.y, a.x + a.width, a.y + a.height))
  }
  let pat = DEFAULT_PATTERN
  // Paper mm per plan px: the framed drawing's own, else the sheet's.
  let paperMmPerPx = sheetMmPerPx ?? cables?.mmPerPx ?? planPaperScale(plan)
  if (frame && fitContent) {
    const mmPerPx =
      fitContent.mmPerPx ??
      planPaperScale(
        { grid_width: frame.w / CELL, grid_height: frame.h / CELL },
        fitContent.paper
      )
    pat = {
      gap: Math.max(PATTERN_GAP, PAPER_PATTERN_GAP_MM / mmPerPx),
      width: Math.max(PATTERN_STROKE.width, PAPER_PATTERN_STROKE_MM / mmPerPx),
    }
    if (cables) cables = { ...cables, mmPerPx, inferredDash: true }
    paperMmPerPx = mmPerPx
  }
  // Readable on paper: mm per cell, and how much each tile grows.
  const readable = objectSize === "readable"
  const mmPerCell = CELL * paperMmPerPx
  const shapeOf = (t: FloorPlanTile) =>
    readableShape(t, mmPerCell, {
      minLong: READABLE_SYMBOL_MM,
      minShort: READABLE_SHORT_MM,
      // No photos on paper: only a tile too thin turns symbol.
      minPhoto: 0,
    })
  const growOf = (t: FloorPlanTile) => (readable ? shapeOf(t).grow : 1)
  if (readable && cables?.stubs)
    cables = {
      ...cables,
      stubs: growStubs(
        cables.stubs,
        tiles,
        mmPerCell,
        READABLE_SYMBOL_MM,
        READABLE_SHORT_MM
      ),
    }
  // The one label pass, at the paper's scale: plan labels, the cables'
  // names along their runs, the trays', the tiles', the areas'.
  const areaGrow = readable ? fontGrow(12, paperMmPerPx, READABLE_FONT_MM) : 1
  const paper = cables ? paperCables(cables) : null
  const labels = layoutPlanLabels({
    scale: mmPerCell,
    unitsPerPx: paperMmPerPx,
    font: LABEL_FONT_MM,
    chipFont: CHIP_FONT_MM,
    repeat: LABEL_REPEAT_MM,
    gap: 0.6,
    tiles,
    shapeOf: readable ? shapeOf : null,
    zoneGrow: readable ? fontGrow(10, paperMmPerPx, READABLE_FONT_MM) : 1,
    trays: showTrays ? trays : [],
    trayWidth: readable
      ? Math.max(10 * paperMmPerPx, READABLE_TRAY_MM)
      : 10 * paperMmPerPx,
    areas: shapes.filter((x): x is AreaShape => x.kind === "area"),
    areaFontPx: 12 * areaGrow,
    planLabels: shapes.filter((x): x is LabelShape => x.kind === "label"),
    cellMm: plan.cell_mm,
    cables:
      cables && paper
        ? {
            paths: cables.paths,
            routes: cables.routes,
            layout: paper.layout,
            bundled: paper.bundled,
            names: cables.labels,
            focus: new Set(cables.highlight ?? []),
            lengths: paper.lod === "near",
            ends: true,
          }
        : undefined,
  })
  const isZone = (t: FloorPlanTile) => t.tile_type?.is_zone ?? false
  const body: string[] = []
  for (const a of areas) {
    const color = a.color || AREA_DEFAULT
    body.push(
      el("rect", {
        x: a.x * CELL,
        y: a.y * CELL,
        width: a.width * CELL,
        height: a.height * CELL,
        rx: 3,
        fill: color,
        "fill-opacity": 0.1,
        stroke: color,
        "stroke-opacity": 0.35,
        "stroke-width": 1.5,
        "stroke-dasharray": "7 4",
      })
    )
  }
  const zoneGrow = readable ? fontGrow(10, paperMmPerPx, READABLE_FONT_MM) : 1
  for (const t of tiles)
    if (isZone(t)) body.push(zoneMarkup(t, showZoneLabels, zoneGrow))
  // Rooms and areas: over the zones, under the tiles.
  for (const s of shapes.filter((x) => x.kind === "area").sort(byZ))
    body.push(areaMarkup(s, pat, areaGrow, labels.areas.get(s.id)))
  const free = plan.layout_mode === "free"
  // Readable: the grown symbols over the rest.
  const solid = tiles.filter((t) => !isZone(t))
  const ordered = readable
    ? [
        ...solid.filter((t) => !shapeOf(t).changed),
        ...solid.filter((t) => shapeOf(t).changed),
      ]
    : solid
  for (const t of ordered) {
    // A free plan's tile turned past its quarter turn (shapes.ts).
    const r = free ? tileBox(t).rotation : 0
    // Too thin to read: its symbol at the drawn size.
    const shape = readable ? shapeOf(t) : null
    if (shape?.symbol) {
      body.push(symbolMarkup(t, shape.box))
      continue
    }
    const g = growOf(t)
    const markup = tileMarkup(
      r ? { ...t, orientation: tileQuarter(t.orientation) } : t,
      colorBy,
      figures?.get(t.id),
      liveState?.tiles[t.id],
      labels.tileNamesHere.has(t.id)
    )
    const ccx = (t.x + t.width / 2) * CELL
    const ccy = (t.y + t.height / 2) * CELL
    const turns = [
      r ? `rotate(${r},${ccx},${ccy})` : "",
      g > 1
        ? `translate(${ccx},${ccy}) scale(${+g.toFixed(4)}) translate(${-ccx},${-ccy})`
        : "",
    ]
      .filter(Boolean)
      .join(" ")
    body.push(turns ? `<g transform="${turns}">${markup}</g>` : markup)
  }
  for (const wall of walls) body.push(wallMarkup(wall, plan.cell_mm))
  if (showTrays)
    for (const tray of trays)
      body.push(trayMarkup(tray, readable ? paperMmPerPx : null, true))
  if (cables) body.push(cablesMarkup(cables))
  body.push(labelsMarkup(labels, paperMmPerPx, showTrays ? trays : []))
  // Labels over everything, as on the canvas.
  for (const s of shapes.filter((x) => x.kind === "label").sort(byZ))
    body.push(labelMarkup(s, plan.cell_mm, readable ? paperMmPerPx : null))
  for (const s of shapes) body.push(opensNoteMarkup(s, plan.cell_mm))
  const vb = frame ?? { x: 0, y: 0, w, h }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" ` +
    `width="${vb.w}" height="${vb.h}" font-family="Inter, sans-serif">` +
    body.join("") +
    "</svg>"
  )
}
