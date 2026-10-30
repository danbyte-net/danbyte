import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
} from "@/lib/api"
import { el, text } from "@/lib/diagram/markup"
import { PAPERS, SHEET } from "@/lib/diagram/sheet"
import type { PaperChoice } from "@/lib/diagram/sheet"
import {
  WALL_THICKNESS_M,
  wallDoorSpans,
  wallSegmentsWithOpenings,
} from "@/components/floorplan3d/world"

import {
  labelColor,
  areaColor,
  areaName,
  boxCenter,
  byZ,
  labelBox,
  labelFontCells,
  polygonCentroid,
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
  longestLegMid,
  paperLod,
  roundedPath,
  sharedColor,
  typePalette,
} from "./cable-draw"
import type { CableColorBy, CableRoute } from "./cable-draw"
import type { Pt } from "./cable-route"
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
}

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
 * light; traced runs are a heavier stroke. No preview or stale marks. */
function cablesMarkup(c: PlanSvgCables): string {
  const routes = c.routes
  const byId = new Map(c.paths.map((cp) => [cp.id, cp]))
  const palette = typePalette(c.paths)
  const layout = layoutCables(routes, laneOrder(c.paths, routes))
  const mmPerCell = CELL * c.mmPerPx
  const lod = paperLod(mmPerCell)
  const bundled = bundledGroups(layout, {
    lod,
    bundle: c.bundle,
    minGapCells: PAPER_LANE_MIN_MM / mmPerCell,
  })
  const hi = new Set(c.highlight ?? [])
  const w = (screenPx: number) => (screenPx * MM_PER_SCREEN_PX) / c.mmPerPx
  const fontPx = 2.2 / c.mmPerPx
  const colorOf = (id: string) => {
    const cp = byId.get(id)
    return (cp && cableColor(cp, c.colorBy, palette)) || CABLE_NONE_PAPER
  }
  const toPx = (pts: readonly Pt[]): Pt[] =>
    pts.map(([x, y]) => [x * CELL, y * CELL])
  const chip = (at: Pt, label: string, color: string) => {
    const cw = label.length * fontPx * 0.6 + fontPx * 0.8
    const ch = fontPx * 1.5
    return (
      el("rect", {
        x: at[0] * CELL - cw / 2,
        y: at[1] * CELL - ch / 2,
        width: cw,
        height: ch,
        rx: ch * 0.2,
        fill: "#ffffff",
        stroke: color,
        "stroke-width": w(1),
      }) +
      text(label, {
        x: at[0] * CELL,
        y: at[1] * CELL + fontPx * 0.35,
        "text-anchor": "middle",
        "font-size": fontPx,
        fill: PAPER_INK,
      })
    )
  }
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
    const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) * mmPerCell
    if (len >= 6)
      parts.push(
        chip(
          [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2],
          String(g.members.length),
          color
        )
      )
  }
  const lines = (id: string, traced: boolean) => {
    const cp = byId.get(id)
    const style =
      CABLE_LINE[cp ? drawnRouteState(cp, routes.get(id)) : "inferred"]
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
          "stroke-width": w(style.width + (traced ? 1.5 : 0)),
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
  for (const id of layout.order) if (!hi.has(id)) parts.push(lines(id, false))
  // Names along the runs, at near detail, where they do not collide.
  if (c.labels && lod === "near") {
    const boxes: { x: number; y: number; w: number; h: number }[] = []
    for (const id of layout.order) {
      const cp = byId.get(id)
      const polys = lanePolylines(
        layout.cables.get(id)!,
        (s) => !!s.group && bundled.has(s.group)
      )
      if (!cp || !polys.length) continue
      const best = polys
        .map((p) => longestLegMid(p))
        .sort((x, y) => y.len - x.len)[0]
      if (best.len * mmPerCell < 15) continue
      const bw = (cp.label.length * fontPx * 0.6 + fontPx) / CELL
      const bh = (fontPx * 1.5) / CELL
      const box = {
        x: best.at[0] - bw / 2,
        y: best.at[1] - bh / 2,
        w: bw,
        h: bh,
      }
      if (
        boxes.some(
          (b) =>
            b.x < box.x + box.w &&
            box.x < b.x + b.w &&
            b.y < box.y + box.h &&
            box.y < b.y + b.h
        )
      )
        continue
      boxes.push(box)
      parts.push(chip(best.at, cp.label, colorOf(id)))
    }
  }
  for (const id of c.highlight ?? [])
    if (layout.cables.has(id)) parts.push(lines(id, true))
  return `<g data-layer="cables">${parts.join("")}</g>`
}

/** An area as the canvas draws it (shape-layer.tsx). */
function areaMarkup(a: AreaShape): string {
  const color = areaColor(a)
  const name = a.show_name ? areaName(a) : ""
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
    return (
      el("polygon", {
        points: a.points.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" "),
        "stroke-linejoin": "round",
        ...style,
      }) +
      (name
        ? text(name, {
            x: cx * CELL,
            y: cy * CELL + 4,
            "text-anchor": "middle",
            "font-size": 12,
            "font-weight": 600,
            fill: color,
          })
        : "")
    )
  }
  const [cx, cy] = boxCenter(a)
  return (
    `<g${a.rotation ? ` transform="rotate(${a.rotation},${cx * CELL},${cy * CELL})"` : ""}>` +
    el("rect", {
      x: a.x * CELL,
      y: a.y * CELL,
      width: a.width * CELL,
      height: a.height * CELL,
      rx: 3,
      ...style,
    }) +
    (name
      ? text(name, {
          x: a.x * CELL + 6,
          y: a.y * CELL + 15,
          "font-size": 12,
          "font-weight": 600,
          fill: color,
        })
      : "") +
    "</g>"
  )
}

/** A label at its real size, in its paper ink. */
function labelMarkup(l: LabelShape, cellMm: number): string {
  const box = labelBox(l, cellMm)
  const [cx, cy] = boxCenter(box)
  const size = labelFontCells(l.font_mm, cellMm) * CELL
  const anchor =
    l.align === "center" ? "middle" : l.align === "right" ? "end" : "start"
  const tx =
    l.align === "center"
      ? (box.x + box.width / 2) * CELL
      : l.align === "right"
        ? (box.x + box.width) * CELL - size * 0.3
        : box.x * CELL + size * 0.3
  const ink = labelColor(l.color).paper
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
    `<g${l.rotation ? ` transform="rotate(${l.rotation},${cx * CELL},${cy * CELL})"` : ""}>` +
    (l.plate
      ? el("rect", {
          x: box.x * CELL,
          y: box.y * CELL,
          width: box.width * CELL,
          height: box.height * CELL,
          rx: Math.min(6, size * 0.2),
          fill: "#ffffff",
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

function zoneMarkup(t: FloorPlanTile, showLabel: boolean): string {
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
      ? text(clip(name, w - 12, 10), {
          x: 6,
          y: 14,
          "font-size": 10,
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
  live: FloorPlanLiveState["tiles"][string] | undefined
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
  const name = tileName(t)
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
  const px = Math.max(3.5, (WALL_THICKNESS_M * 1000 * CELL) / cellMm)
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

function trayMarkup(tray: FloorPlanTray): string {
  if (tray.points.length < 2) return ""
  const color = tray.color || TRAY_DEFAULT
  const pts = tray.points.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
  const mid = tray.points[Math.floor(tray.points.length / 2)]
  return (
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: color,
      "stroke-opacity": 0.3,
      "stroke-width": 10,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }) +
    (tray.name
      ? text(tray.name, {
          x: mid[0] * CELL + 8,
          y: mid[1] * CELL - 8,
          "font-size": 9,
          fill: color,
        })
      : "")
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
}: PlanSvgInput): string {
  const w = plan.grid_width * CELL
  const h = plan.grid_height * CELL
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
  for (const t of tiles) if (isZone(t)) body.push(zoneMarkup(t, showZoneLabels))
  // Rooms and areas: over the zones, under the tiles.
  for (const s of shapes.filter((x) => x.kind === "area").sort(byZ))
    body.push(areaMarkup(s))
  const free = plan.layout_mode === "free"
  for (const t of tiles)
    if (!isZone(t)) {
      // A free plan's tile turned past its quarter turn (shapes.ts).
      const r = free ? tileBox(t).rotation : 0
      const markup = tileMarkup(
        r ? { ...t, orientation: tileQuarter(t.orientation) } : t,
        colorBy,
        figures?.get(t.id),
        liveState?.tiles[t.id]
      )
      body.push(
        r
          ? `<g transform="rotate(${r},${(t.x + t.width / 2) * CELL},${(t.y + t.height / 2) * CELL})">${markup}</g>`
          : markup
      )
    }
  for (const wall of walls) body.push(wallMarkup(wall, plan.cell_mm))
  if (showTrays) for (const tray of trays) body.push(trayMarkup(tray))
  if (cables) body.push(cablesMarkup(cables))
  // Labels over everything, as on the canvas.
  for (const s of shapes.filter((x) => x.kind === "label").sort(byZ))
    body.push(labelMarkup(s, plan.cell_mm))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `width="${w}" height="${h}" font-family="Inter, sans-serif">` +
    body.join("") +
    "</svg>"
  )
}
