import type {
  FloorPlan,
  FloorPlanLiveState,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
} from "@/lib/api"
import { el, text } from "@/lib/diagram/markup"
import {
  WALL_THICKNESS_M,
  wallDoorSpans,
  wallSegmentsWithOpenings,
} from "@/components/floorplan3d/world"

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
  plan: Pick<FloorPlan, "grid_width" | "grid_height" | "cell_mm">
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
  colorBy?: ColorBy
  figures?: ReadonlyMap<string, RackFigures>
  liveState?: FloorPlanLiveState | null
  showZoneLabels?: boolean
  showTrays?: boolean
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
  colorBy = "type",
  figures,
  liveState,
  showZoneLabels = true,
  showTrays = true,
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
  for (const t of tiles)
    if (!isZone(t))
      body.push(
        tileMarkup(t, colorBy, figures?.get(t.id), liveState?.tiles[t.id])
      )
  for (const wall of walls) body.push(wallMarkup(wall, plan.cell_mm))
  if (showTrays) for (const tray of trays) body.push(trayMarkup(tray))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `width="${w}" height="${h}" font-family="Inter, sans-serif">` +
    body.join("") +
    "</svg>"
  )
}
