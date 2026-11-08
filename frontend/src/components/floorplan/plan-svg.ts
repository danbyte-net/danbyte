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
import { readableText } from "@/lib/color"
import { attrs as markupAttrs, el, esc, text } from "@/lib/diagram/markup"
import { PAPERS, SHEET } from "@/lib/diagram/sheet"
import type { PaperChoice } from "@/lib/diagram/sheet"
import {
  WALL_THICKNESS_M,
  wallDoorSpans,
  wallSegmentsWithOpenings,
} from "@/components/floorplan3d/world"

import { mix } from "@/lib/diagram/theme"

import {
  AREA_INK_SHARE,
  AREA_STROKE_OPACITY,
  PATTERN_GAP,
  PATTERN_STROKE,
  labelColor,
  areaColor,
  areaIcon,
  areaLabelColor,
  areaName,
  areaNameHalo,
  areaNameHaloColor,
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
import { facingBarRect, figureBarRect, figureLift } from "./tile-marks"
import { planTilePose, residualTransform } from "./tile-pose"
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
import {
  CALLOUT_FONT_PX,
  CALLOUT_LINE_FONT_PX,
  CALLOUT_LINE_PX,
  CALLOUT_PAD_X,
  CALLOUT_PAD_Y,
  calloutValue,
} from "./plan-callouts"
import {
  HALL_FONT_PX,
  barThickness,
  planLod,
  planRooms,
  planRows,
  roomAt,
  symbolBox,
  withSymbols,
} from "./plan-lod"
import { TRAY_BED_OPACITY, TRAY_EDGE_OPACITY, TRAY_EDGE_PX } from "./tray-layer"
import type {
  AlongLabel,
  CalloutLabel,
  IconClusterLabel,
  PlanLabels,
} from "./plan-label-pass"
import {
  CHIP_FONT_MM,
  LABEL_FONT_MM,
  LABEL_FONT_PX,
  LABEL_REPEAT_MM,
  textSize,
} from "./plan-labels"
import {
  ICON_TILE_MM,
  READABLE_FONT_MM,
  READABLE_SHORT_MM,
  READABLE_SYMBOL_MM,
  READABLE_TRAY_MM,
  fontGrow,
  growStubs,
  iconTileShape,
  isIconTile,
  readableShape,
} from "./readable"
import type { CellBox, ObjectSize, ReadableShape } from "./readable"
import { tileIcon } from "@/components/object-icon"
import {
  CLUSTER_SIDE,
  clusterFace,
  drawnCentre,
  layoutIcons,
  scaleBox,
  squareAt,
} from "./icon-layout"
import type { ClusterFace, IconCluster, IconLayout } from "./icon-layout"
import { outlinePath, raisedRegions } from "./raised-floor-shape"
import { CHECK_COLOR, rackFigures, tileFill, tilePaint } from "./tile-paint"
import { cameraViews, polygonPath } from "./camera-view"
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
  /** The raised floors; touching ones of one depth and colour draw as
   * one region (raised-floor-shape.ts), as on the canvas. */
  areas?: {
    x: number
    y: number
    width: number
    height: number
    points?: [number, number][]
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
  /** Icons when zoomed out: a device, rack or cabinet under ICON_TILE_MM
   * on its long side prints as its icon tile, READABLE_SYMBOL_MM square. */
  iconTiles?: boolean
  /** Paper mm per plan px of the sheet (planPaperScale) when the drawing
   * is not framed to its content; A3 landscape otherwise. */
  mmPerPx?: number
  /** Display > Camera FOV cones: each camera's view, cut short by the
   * walls (camera-view.ts) - `racksBlock` as Display > Racks block view. */
  cameras?: { racksBlock: boolean }
  /** Display > Callouts (Auto): names that do not fit in their tile go
   * along their row or in a callout, and rows from afar into their row
   * symbol or room summary, as on the canvas at the paper's scale. False
   * keeps names in their tiles (a view's sheet lays the screen's callouts
   * over it instead). */
  callouts?: boolean
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
  // A black or white name (a strong fill) is haloed in the other one.
  const halo = areaNameHalo(a) ? "#ffffff" : areaNameHaloColor(ink)
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
          fill: halo,
          stroke: halo,
          "stroke-width": 3.5 * grow,
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
  // In the area's own colour, a name keeps some of the page's ink (as
  // shape-layer.tsx draws it on screen).
  const own = areaLabelColor(a)
  const ink = own === color ? mix(color, PAPER_INK, AREA_INK_SHARE) : own
  const name = a.show_name && nameAt !== null ? areaName(a) : ""
  const style = {
    fill: color,
    "fill-opacity": a.fill_opacity / 100,
    stroke: color,
    "stroke-opacity": a.border === "none" ? 0 : AREA_STROKE_OPACITY,
    "stroke-width": 1.25,
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
  // tile-marks.ts keeps the facing bar clear of the figure bar.
  const bar = facingBarRect(w, h, t.orientation, !!paint.figure)
  parts.push(
    el("rect", {
      x: bar.x,
      y: bar.y,
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
  const lift = figure ? figureLift(t.orientation) : 0
  const name = hideName ? "" : tileName(t)
  if (name) {
    const room = stacked ? h - 14 : h
    const size = stacked ? Math.min(11, room * 0.45) : 11
    const y = stacked ? (h - 14 - lift) / 2 + size / 3 : h / 2 + size / 3
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
    const fb = figureBarRect(w, h, t.orientation)
    const bw = fb.width
    parts.push(
      el("rect", {
        x: fb.x,
        y: fb.y,
        width: bw,
        height: fb.height,
        rx: 2,
        fill: PAPER_INK,
        "fill-opacity": 0.1,
      })
    )
    if (figure.ratio != null)
      parts.push(
        el("rect", {
          x: fb.x,
          y: fb.y,
          width: Math.max(2, bw * Math.min(1, figure.ratio)),
          height: fb.height,
          rx: 2,
          fill: figure.color,
        })
      )
    if (figureText)
      parts.push(
        text(figureText, {
          x: wide ? w - GUTTER - 4 : w / 2,
          y: h - GUTTER - 10 - lift,
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
    // The channel's sides, then its bed, as the canvas draws a tray.
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: color,
      "stroke-opacity": TRAY_EDGE_OPACITY,
      "stroke-width": +(
        width + (mmPerPx == null ? TRAY_EDGE_PX : 0.2 / mmPerPx)
      ).toFixed(2),
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      "data-part": "edge",
    }) +
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": +width.toFixed(2),
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      "data-part": "bed",
    }) +
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: color,
      "stroke-opacity": TRAY_BED_OPACITY,
      "stroke-width": +width.toFixed(2),
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      "data-part": "channel",
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
  const along = (
    l: AlongLabel,
    fill: string,
    weight: number,
    plate = false
  ) => {
    // A cable's name on its line: a white plate under it, so the line
    // breaks cleanly round the text (canvas: plan-labels-layer.tsx).
    const size = textSize(l.text + (l.suffix ?? ""), font)
    const plateMarkup = plate
      ? el("rect", {
          transform: `translate(${r(l.at[0] * CELL)},${r(l.at[1] * CELL)})${l.angle ? ` rotate(${r(l.angle)})` : ""}`,
          x: r(-size.w / 2),
          y: r(-size.h / 2),
          width: r(size.w),
          height: r(size.h),
          rx: r(size.h * 0.2),
          fill: "#ffffff",
        })
      : ""
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
      plateMarkup +
      text(l.text + (l.suffix ?? ""), {
        ...attrs,
        fill: "#ffffff",
        stroke: "#ffffff",
        "stroke-width": halo,
        "stroke-linejoin": "round",
      }) +
      `<text${markupAttrs({ ...attrs, fill })}>${body}</text>`
    )
  }
  const parts: string[] = []
  for (const l of labels.trays)
    parts.push(along(l, color.get(l.id) ?? TRAY_DEFAULT, 600))
  for (const l of labels.bundles) parts.push(along(l, PAPER_INK, 600, true))
  for (const l of labels.cables) parts.push(along(l, PAPER_INK, 500, true))
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

// ─── The callouts on paper ──────────────────────────────────────────────

const r2 = (n: number) => +n.toFixed(2)

/** The screen's callouts (plan-callouts-layer.tsx) as paper markup: each a
 * plain bordered box at the size it has on screen at zoom `k`, its name,
 * its lines (a status or role as its badge) and a muted leader to a dot on
 * its tile - light-themed, in plan px. */
export function calloutsMarkup(
  callouts: readonly CalloutLabel[],
  k: number
): string {
  if (!callouts.length || !(k > 0)) return ""
  const s = 1 / k
  const out: string[] = ['<g data-layer="callouts">']
  for (const c of callouts) {
    // A summary over what it names: no leader.
    if (c.leader[0][0] === c.leader[1][0] && c.leader[0][1] === c.leader[1][1])
      continue
    const cx = c.at[0] * CELL
    const cy = c.at[1] * CELL
    const { w, h } = c.size
    const tip: [number, number] =
      c.side === "top"
        ? [0, h / 2]
        : c.side === "bottom"
          ? [0, -h / 2]
          : c.side === "left"
            ? [w / 2, 0]
            : [-w / 2, 0]
    const fx = cx + tip[0] * s
    const fy = cy + tip[1] * s
    const tx = c.leader[1][0] * CELL
    const ty = c.leader[1][1] * CELL
    out.push(
      `<line x1="${r2(fx)}" y1="${r2(fy)}" x2="${r2(tx)}" y2="${r2(ty)}" ` +
        `stroke="#71717a" stroke-width="${r2(1.25 * s)}" stroke-linecap="round"/>` +
        `<circle cx="${r2(tx)}" cy="${r2(ty)}" r="${r2(2.25 * s)}" fill="#71717a"/>`
    )
  }
  for (const c of callouts) {
    const cx = c.at[0] * CELL
    const cy = c.at[1] * CELL
    const { w, h } = c.size
    const left = -w / 2 + CALLOUT_PAD_X
    const parts = [
      `<rect x="${r2(-w / 2)}" y="${r2(-h / 2)}" width="${r2(w)}" height="${r2(h)}" ` +
        `rx="4" fill="#ffffff" stroke="#d4d4d8" stroke-width="1"/>`,
      `<text x="${r2(left)}" y="${r2(-h / 2 + CALLOUT_PAD_Y + CALLOUT_FONT_PX * 0.95)}" ` +
        `font-size="${CALLOUT_FONT_PX}" font-weight="500" fill="${PAPER_INK}">` +
        `${esc(c.name)}</text>`,
    ]
    c.lines.forEach((l, i) => {
      const y =
        -h / 2 +
        CALLOUT_PAD_Y +
        CALLOUT_FONT_PX * 1.3 +
        i * CALLOUT_LINE_PX +
        CALLOUT_LINE_PX / 2
      const value = esc(calloutValue(l.value))
      const base = r2(y + CALLOUT_LINE_FONT_PX * 0.35)
      if (l.color === undefined) {
        parts.push(
          `<text x="${r2(left)}" y="${base}" font-size="${CALLOUT_LINE_FONT_PX}" ` +
            `fill="#71717a">${value}</text>`
        )
        return
      }
      const bg = /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : "#f4f4f5"
      const fg = bg === "#f4f4f5" ? "#3f3f46" : readableText(bg)
      const tw = calloutValue(l.value).length * CALLOUT_LINE_FONT_PX * 0.6 + 8
      parts.push(
        `<rect x="${r2(left)}" y="${r2(y - 6.5)}" width="${r2(tw)}" height="13" ` +
          `rx="3" fill="${bg}"/>` +
          `<text x="${r2(left + 4)}" y="${base}" font-size="${CALLOUT_LINE_FONT_PX}" ` +
          `font-weight="500" fill="${fg}">${value}</text>`
      )
    })
    out.push(
      `<g transform="translate(${r2(cx)},${r2(cy)}) scale(${+s.toFixed(5)})">` +
        parts.join("") +
        "</g>"
    )
  }
  out.push("</g>")
  return out.join("")
}

/** A row of icons on paper (plan-lod.ts): one bar along its line in its
 * racks' colour, as RowSymbolTile draws it; `k` units per plan px. */
function rowBarMarkup(
  c: IconCluster,
  face: ClusterFace,
  thick: number,
  k: number
): string {
  const r = (n: number) => +n.toFixed(2)
  const row = c.row!
  const l = row.length * CELL
  const t = thick * CELL
  const angle = (Math.atan2(row.dir[1], row.dir[0]) * 180) / Math.PI
  const alarm = face.check ? CHECK_COLOR[face.check] : undefined
  return el("rect", {
    "data-row-symbol": c.id,
    transform: `translate(${r(c.anchor[0] * CELL)},${r(c.anchor[1] * CELL)}) rotate(${r(angle)})`,
    x: r(-l / 2),
    y: r(-t / 2),
    width: r(l),
    height: r(t),
    rx: r(Math.min(t / 2, 3 / k)),
    fill: face.fill,
    "fill-opacity": 0.9,
    stroke: alarm ?? "#ffffff",
    "stroke-width": r((alarm ? 2 : 1.25) / k),
  })
}

/** A room's summary on paper (plan-lod.ts): a plate with the racks' icon
 * square and "Data Hall 1 · 120 racks", as HallSymbolTile draws it. */
function hallMarkup(
  id: string,
  box: CellBox,
  face: ClusterFace,
  k: number
): string {
  const r = (n: number) => +n.toFixed(2)
  const x = box.x * CELL
  const y = box.y * CELL
  const w = box.w * CELL
  const h = box.h * CELL
  const pad = 3 / k
  const sq = h - pad * 2
  const alarm = face.check ? CHECK_COLOR[face.check] : undefined
  const Icon = face.icon ? getLucideIcon(face.icon) : null
  const icon = Icon
    ? renderToStaticMarkup(
        createElement(Icon, {
          x: r(x + pad + sq * 0.2),
          y: r(y + pad + sq * 0.2),
          width: r(sq * 0.6),
          height: r(sq * 0.6),
          color: "#ffffff",
          strokeWidth: 2.25,
        })
      )
    : ""
  return (
    `<g data-hall-symbol="${esc(id)}">` +
    el("rect", {
      x: r(x),
      y: r(y),
      width: r(w),
      height: r(h),
      rx: r(4 / k),
      fill: "#ffffff",
      stroke: alarm ?? "#d4d4d8",
      "stroke-width": r((alarm ? 2 : 1) / k),
    }) +
    el("rect", {
      x: r(x + pad),
      y: r(y + pad),
      width: r(sq),
      height: r(sq),
      rx: r(3 / k),
      fill: face.fill,
    }) +
    icon +
    text(face.name, {
      x: r(x + pad * 2 + sq + 2 / k),
      y: r(y + h / 2 + (HALL_FONT_PX / k) * 0.35),
      "font-size": r(HALL_FONT_PX / k),
      "font-weight": 600,
      fill: PAPER_INK,
    }) +
    "</g>"
  )
}

/** Rows named along them on paper: bold text on a white plate with a
 * light border, as plan-labels-layer.tsx draws them; `k` units per plan
 * px. */
function rowNamesMarkup(
  rows: readonly {
    id: string
    text: string
    at: Pt
    angle: number
    size: { w: number; h: number }
  }[],
  k: number
): string {
  if (!rows.length) return ""
  const r = (n: number) => +n.toFixed(2)
  const s = 1 / k
  const out = ['<g data-layer="row-names">']
  for (const row of rows) {
    const transform = `translate(${r(row.at[0] * CELL)},${r(row.at[1] * CELL)})${row.angle ? ` rotate(${r(row.angle)})` : ""}`
    out.push(
      `<g data-row-name="${esc(row.id)}" transform="${transform}">` +
        el("rect", {
          x: r((-row.size.w / 2) * s),
          y: r((-row.size.h / 2) * s),
          width: r(row.size.w * s),
          height: r(row.size.h * s),
          rx: r(3 * s),
          fill: "#ffffff",
          stroke: "#d4d4d8",
          "stroke-width": r(s),
        }) +
        text(row.text, {
          y: r(LABEL_FONT_PX * s * 0.35),
          "text-anchor": "middle",
          "font-size": r(LABEL_FONT_PX * s),
          "font-weight": 600,
          fill: PAPER_INK,
        }) +
        "</g>"
    )
  }
  out.push("</g>")
  return out.join("")
}

/** A tile too thin, or too small, to read on paper: its symbol - a
 * rounded box in its colour at the drawn size (`box`, cells) with its icon
 * in white (object-icon.ts), as the canvas draws it (ReadableSymbol). */
function symbolMarkup(
  t: FloorPlanTile,
  box: CellBox,
  iconTile = false,
  rotation = 0
): string {
  const r = (n: number) => +n.toFixed(2)
  const w = box.w * CELL
  const h = box.h * CELL
  const side = Math.min(w, h) * (iconTile ? 0.6 : 0.7)
  // A slender tile's symbol lies turned with it (its icon stays upright).
  const turn = rotation
    ? `rotate(${r(rotation)},${r(box.x * CELL + w / 2)},${r(box.y * CELL + h / 2)})`
    : undefined
  return (
    el("rect", {
      transform: turn,
      x: r(box.x * CELL),
      y: r(box.y * CELL),
      width: r(w),
      height: r(h),
      rx: r(Math.min(w, h) * 0.2),
      fill: tileFill(t),
      "fill-opacity": 0.9,
      stroke: tileFill(t),
      "data-symbol": t.id,
      ...(iconTile ? { "data-icon-tile": t.id } : {}),
    }) +
    iconMarkup(
      tileIcon(t),
      r(box.x * CELL + w / 2 - side / 2),
      r(box.y * CELL + h / 2 - side / 2),
      r(side),
      "#ffffff"
    )
  )
}

/** A spread icon's leader on paper: a hairline from its drawn centre back
 * to its true one (cells), a dot there. */
function leaderMarkup(from: Pt, to: Pt, mmPerPx: number): string {
  const r = (n: number) => +n.toFixed(2)
  return (
    el("line", {
      x1: r(from[0] * CELL),
      y1: r(from[1] * CELL),
      x2: r(to[0] * CELL),
      y2: r(to[1] * CELL),
      stroke: MUTED_INK,
      "stroke-width": r(0.2 / mmPerPx),
      "data-icon-leader": "",
    }) +
    el("circle", {
      cx: r(to[0] * CELL),
      cy: r(to[1] * CELL),
      r: r(0.5 / mmPerPx),
      fill: MUTED_INK,
    })
  )
}

/** A cluster tile on paper, as the canvas draws it (ClusterTile): the
 * stack, the shared icon, the worst state's outline and the count. */
function clusterMarkup(
  id: string,
  box: CellBox,
  face: ClusterFace,
  mmPerPx: number
): string {
  const r = (n: number) => +n.toFixed(2)
  const x = box.x * CELL
  const y = box.y * CELL
  const w = box.w * CELL
  const h = box.h * CELL
  const rx = Math.min(w, h) * 0.2
  const alarm = face.check ? CHECK_COLOR[face.check] : undefined
  const off = 0.6 / mmPerPx
  const icon = Math.min(w, h) * 0.55
  const count = String(face.count)
  const font = 1.6 / mmPerPx
  const bh = font * 1.4
  const bw = count.length * font * 0.62 + font * 0.8
  const bx = x + w - bw * 0.6
  const by = y - bh * 0.45
  return (
    `<g data-icon-cluster="${esc(id)}">` +
    el("rect", {
      x: r(x + off),
      y: r(y - off),
      width: r(w),
      height: r(h),
      rx: r(rx),
      fill: face.fill,
      "fill-opacity": 0.45,
      stroke: "#ffffff",
      "stroke-width": r(0.2 / mmPerPx),
    }) +
    el("rect", {
      x: r(x),
      y: r(y),
      width: r(w),
      height: r(h),
      rx: r(rx),
      fill: face.fill,
      "fill-opacity": 0.95,
      stroke: alarm ?? "#ffffff",
      "stroke-width": r((alarm ? 0.4 : 0.2) / mmPerPx),
    }) +
    iconMarkup(
      face.icon,
      r(x + w / 2 - icon / 2),
      r(y + h / 2 - icon / 2),
      r(icon),
      "#ffffff"
    ) +
    el("rect", {
      x: r(bx),
      y: r(by),
      width: r(bw),
      height: r(bh),
      rx: r(bh * 0.28),
      fill: PAPER_INK,
      stroke: "#ffffff",
      "stroke-width": r(0.15 / mmPerPx),
    }) +
    text(count, {
      x: r(bx + bw / 2),
      y: r(by + bh / 2 + font * 0.35),
      "text-anchor": "middle",
      "font-size": r(font),
      "font-weight": 600,
      fill: "#ffffff",
    }) +
    "</g>"
  )
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
  iconTiles = false,
  mmPerPx: sheetMmPerPx,
  cameras,
  callouts = false,
}: PlanSvgInput): string {
  const w = plan.grid_width * CELL
  const h = plan.grid_height * CELL
  // Before a close-up drops the walls out of its box: one there still
  // stops a view that reaches in.
  const views = cameras
    ? cameraViews(tiles, walls, {
        cellMm: plan.cell_mm,
        racksBlock: cameras.racksBlock,
      })
    : []
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
  // Icons on paper: one threshold, no zoom to hover about it.
  const iconIds = new Set(
    iconTiles
      ? tiles
          .filter((t) => isIconTile(t, mmPerCell, false, ICON_TILE_MM))
          .map((t) => t.id)
      : []
  )
  const readableOf = (t: FloorPlanTile) =>
    readableShape(t, mmPerCell, {
      minLong: READABLE_SYMBOL_MM,
      minShort: READABLE_SHORT_MM,
      // No photos on paper: only a tile too thin turns symbol.
      minPhoto: 0,
    })
  // What the page shows (cells): the frame, else the grid. Its edge clips,
  // so icons and their names keep inside - folded into a cluster rather
  // than cut off.
  const page = frame ?? { x: 0, y: 0, w, h }
  const pageCells: CellBox = {
    x: page.x / CELL,
    y: page.y / CELL,
    w: page.w / CELL,
    h: page.h / CELL,
  }
  // Icons that would overlap on paper: spread, or folded into clusters,
  // as on the canvas (icon-layout.ts) - at the paper's scale.
  // The label pass's units on paper: screen px as the canvas has them,
  // LABEL_FONT_PX to LABEL_FONT_MM - so callouts, row names and room
  // summaries keep the canvas's proportions at the paper's scale.
  const toPx = LABEL_FONT_PX / LABEL_FONT_MM
  const unitPerCell = mmPerCell * toPx
  // Rows from afar (plan-lod.ts), with Callouts: a row of icons as one
  // symbol, a room's rows as one summary - never clusters of a few.
  const areaShapes = shapes.filter((x): x is AreaShape => x.kind === "area")
  const rooms = planRooms(areaShapes)
  const rowLod =
    callouts && iconIds.size
      ? planLod(
          planRows(
            tiles,
            rooms,
            plan.layout_mode === "free" ? (t) => tileBox(t).rotation : undefined
          ),
          { tiles, iconIds, rooms, scale: unitPerCell }
        )
      : null
  const looseIcons = tiles
    .filter((t) => iconIds.has(t.id) && !rowLod?.ownerOf.has(t.id))
    .map((t) => ({
      id: t.id,
      c: [t.x + t.width / 2, t.y + t.height / 2] as Pt,
    }))
  const roomOfIcon = new Map(
    looseIcons.map((it) => [it.id, roomAt(rooms, it.c)?.id ?? null])
  )
  const looseLayout: IconLayout = layoutIcons(looseIcons, mmPerCell, {
    side: READABLE_SYMBOL_MM,
    bounds: scaleBox(pageCells, mmPerCell),
    spill: false,
    groupOf: callouts ? (id) => roomOfIcon.get(id) : undefined,
  })
  const icons = rowLod ? withSymbols(looseLayout, rowLod) : looseLayout
  const tileById = new Map(tiles.map((t) => [t.id, t]))
  const clusterBoxOf = (c: IconCluster) =>
    symbolBox(c, unitPerCell) ??
    squareAt(
      drawnCentre(icons, c.id, c.anchor, mmPerCell),
      READABLE_SYMBOL_MM * CLUSTER_SIDE,
      mmPerCell
    )
  const faces = new Map<string, ClusterFace>(
    icons.clusters.map((c) => {
      const face = clusterFace(
        c.members.map((id) => tileById.get(id)!),
        (t) => liveState?.tiles[t.id]?.check
      )
      return [c.id, c.text ? { ...face, name: c.text } : face]
    })
  )
  /** How a tile prints when not as itself, or null. */
  const shapeOf = (t: FloorPlanTile): ReadableShape | null => {
    if (!iconIds.has(t.id)) return readable ? readableOf(t) : null
    const c = icons.clusterOf.get(t.id)
    // A row's bar: each rack where it is, under it.
    if (c?.row?.bar)
      return {
        box: { x: t.x, y: t.y, w: t.width, h: t.height },
        grow: 1,
        changed: true,
        symbol: true,
      }
    if (!c && !icons.offsets.has(t.id))
      return iconTileShape(t, mmPerCell, READABLE_SYMBOL_MM)
    const box = c
      ? clusterBoxOf(c)
      : squareAt(
          drawnCentre(
            icons,
            t.id,
            [t.x + t.width / 2, t.y + t.height / 2],
            mmPerCell
          ),
          READABLE_SYMBOL_MM,
          mmPerCell
        )
    return {
      box,
      grow: box.w / Math.max(t.width, t.height),
      changed: true,
      symbol: true,
    }
  }
  const anyShape = readable || iconIds.size > 0
  const growOf = (t: FloorPlanTile) => shapeOf(t)?.grow ?? 1
  if (anyShape && cables?.stubs)
    cables = {
      ...cables,
      stubs: growStubs(
        cables.stubs,
        tiles,
        mmPerCell,
        READABLE_SYMBOL_MM,
        READABLE_SHORT_MM,
        shapeOf
      ),
    }
  // The one label pass, at the paper's scale: plan labels, the cables'
  // names along their runs, the trays', the tiles', the areas'.
  const areaGrow = readable ? fontGrow(12, paperMmPerPx, READABLE_FONT_MM) : 1
  const paper = cables ? paperCables(cables) : null
  const iconClusters: IconClusterLabel[] = icons.clusters.map((c) => ({
    id: c.id,
    box: clusterBoxOf(c),
    name:
      c.form === "row" && !c.row?.bar
        ? (c.short ?? "")
        : (faces.get(c.id)?.name ?? ""),
    members: c.members,
    row:
      c.row?.bar && c.text
        ? {
            centre: c.anchor,
            dir: c.row.dir,
            length: c.row.length,
            thick: barThickness(c.row.depth, unitPerCell),
            text: c.text,
            short: c.short ?? c.text,
          }
        : undefined,
    hall: c.form === "hall" ? c.room : undefined,
  }))
  const labels = layoutPlanLabels({
    scale: unitPerCell,
    unitsPerPx: paperMmPerPx * toPx,
    font: LABEL_FONT_MM * toPx,
    chipFont: CHIP_FONT_MM * toPx,
    repeat: LABEL_REPEAT_MM * toPx,
    gap: 0.6 * toPx,
    bounds: scaleBox(pageCells, unitPerCell),
    boundsOnly: true,
    tiles,
    shapeOf: anyShape ? shapeOf : null,
    iconIds,
    iconClusters,
    roomOf: (p) => roomAt(rooms, p),
    callouts: callouts ? {} : null,
    angleOf:
      plan.layout_mode === "free" ? (t) => tileBox(t).rotation : undefined,
    zoneGrow: readable ? fontGrow(10, paperMmPerPx, READABLE_FONT_MM) : 1,
    trays: showTrays ? trays : [],
    trayWidth:
      (readable
        ? Math.max(10 * paperMmPerPx, READABLE_TRAY_MM)
        : 10 * paperMmPerPx) * toPx,
    areas: areaShapes,
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
  for (const rg of raisedRegions(areas)) {
    const color = rg.color || AREA_DEFAULT
    body.push(
      el("path", {
        d: outlinePath(rg.pieces, CELL),
        fill: color,
        "fill-opacity": 0.1,
        stroke: "none",
      }),
      el("path", {
        d: outlinePath(rg.outline, CELL, false),
        fill: "none",
        stroke: color,
        "stroke-opacity": 0.35,
        "stroke-width": 1.5,
        "stroke-dasharray": "7 4",
        "stroke-linejoin": "round",
      })
    )
  }
  const zoneGrow = readable ? fontGrow(10, paperMmPerPx, READABLE_FONT_MM) : 1
  const free = plan.layout_mode === "free"
  for (const t of tiles)
    if (isZone(t)) {
      // Turned past its quarter turn on a free plan, as the canvas draws it.
      const turn = free ? residualTransform(planTilePose(t), CELL) : ""
      const markup = zoneMarkup(t, showZoneLabels, zoneGrow)
      body.push(turn ? `<g transform="${turn}">${markup}</g>` : markup)
    }
  // Rooms and areas: over the zones, under the tiles.
  for (const s of shapes.filter((x) => x.kind === "area").sort(byZ))
    body.push(areaMarkup(s, pat, areaGrow, labels.areas.get(s.id)))
  // Readable: the grown symbols over the rest.
  const solid = tiles.filter((t) => !isZone(t))
  const ordered = anyShape
    ? [
        ...solid.filter((t) => !shapeOf(t)?.changed),
        ...solid.filter((t) => shapeOf(t)?.changed),
      ]
    : solid
  // Spread icons: a leader back to where each really is.
  for (const t of ordered) {
    const o = icons.offsets.get(t.id)
    if (!o || icons.clusterOf.has(t.id)) continue
    const home: Pt = [t.x + t.width / 2, t.y + t.height / 2]
    body.push(
      leaderMarkup(
        drawnCentre(icons, t.id, home, mmPerCell),
        home,
        paperMmPerPx
      )
    )
  }
  for (const t of ordered) {
    // Folded into a cluster: the cluster prints it.
    if (icons.clusterOf.has(t.id)) continue
    // A free plan's tile turned past its quarter turn (shapes.ts).
    const r = free ? tileBox(t).rotation : 0
    // Too thin to read: its symbol at the drawn size.
    const shape = shapeOf(t)
    if (shape?.symbol) {
      body.push(
        symbolMarkup(t, shape.box, iconIds.has(t.id), iconIds.has(t.id) ? 0 : r)
      )
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
  for (const c of icons.clusters) {
    const face = faces.get(c.id)!
    if (c.form === "row" && c.row?.bar)
      body.push(
        rowBarMarkup(
          c,
          face,
          barThickness(c.row.depth, unitPerCell),
          toPx * paperMmPerPx
        )
      )
    else if (c.form === "hall")
      body.push(hallMarkup(c.id, clusterBoxOf(c), face, toPx * paperMmPerPx))
    else body.push(clusterMarkup(c.id, clusterBoxOf(c), face, paperMmPerPx))
  }
  // The cameras' views: over the tiles, under the walls, as on the canvas.
  for (const v of views)
    body.push(
      el("path", {
        d: polygonPath(v.polygon, CELL),
        fill: v.color,
        "fill-opacity": v.ring ? 0.08 : 0.12,
        stroke: v.color,
        "stroke-opacity": 0.45,
        "stroke-width": 1,
        "stroke-dasharray": "4 3",
        "stroke-linejoin": "round",
        "data-fov": v.id,
      })
    )
  for (const wall of walls) body.push(wallMarkup(wall, plan.cell_mm))
  if (showTrays)
    for (const tray of trays)
      body.push(trayMarkup(tray, readable ? paperMmPerPx : null, true))
  if (cables) body.push(cablesMarkup(cables))
  body.push(labelsMarkup(labels, paperMmPerPx, showTrays ? trays : []))
  // Row names and callouts, at the canvas's sizes for the paper's scale.
  body.push(rowNamesMarkup(labels.rows, toPx * paperMmPerPx))
  body.push(calloutsMarkup(labels.callouts, toPx * paperMmPerPx))
  // Labels over everything, as on the canvas.
  for (const s of shapes.filter((x) => x.kind === "label").sort(byZ))
    body.push(labelMarkup(s, plan.cell_mm, readable ? paperMmPerPx : null))
  for (const s of shapes) body.push(opensNoteMarkup(s, plan.cell_mm))
  const vb = page
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" ` +
    `width="${vb.w}" height="${vb.h}" font-family="Inter, sans-serif">` +
    body.join("") +
    "</svg>"
  )
}
