import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanContents,
  FloorPlanReportTables,
} from "@/lib/api"
import { PAPERS, SHEET } from "@/lib/diagram/sheet"
import type { PaperChoice } from "@/lib/diagram/sheet"

import { areaLegendEntries } from "./area-legend"
import {
  CableRouteCache,
  cableLegend,
  cableLegendEntries,
  cableStubs,
  hasSharedRuns,
  typePalette,
} from "./cable-draw"
import type { CableColorBy } from "./cable-draw"
import { planSvg } from "./plan-svg"
import type { PlanBox } from "./plan-svg"
import type { ObjectSize } from "./readable"
import { shapeBounds, shapesOf } from "./shapes"
import type { AreaShape, PlanShape } from "./shapes"

// The callouts on paper moved to plan-svg.ts; their callers import them here.
export { calloutsMarkup } from "./plan-svg"

// The floor-plan report (api/floor_plan_report.py): one PDF of what the
// screen shows, the whole floor, a room or area, or every level of the
// building - plan sheets, cable schedule, inventory and ports. The server
// works out what the scope covers and builds the tables; the page draws
// the plan for each sheet, framed to the sheet's box at its paper scale.

export type ReportScope = "view" | "floor" | "area" | "building"
export type ReportInclude = "plan" | "cables" | "inventory" | "ports"

/** Plan px per cell (floor-canvas.tsx). */
const CELL = 40
/** Cells round a room or area on its sheet (AREA_MARGIN_CELLS). */
export const AREA_MARGIN_CELLS = 2
/** A plan sheet's page (mm): the running footer's bottom margin, the
 * sheet's heading and its strip of scale bar and legends - as
 * floor_plan_report.py lays it out. */
const BOTTOM_MM = 14
const HEAD_MM = 8
const FOOT_MM = 20

/** The plan's room on a plan sheet (mm). */
export function reportSheetMm(paper: PaperChoice): { w: number; h: number } {
  let [pw, ph] = PAPERS[paper.size]
  if (paper.orientation === "portrait") [pw, ph] = [ph, pw]
  return {
    w: pw - 2 * SHEET.MARGIN,
    h: ph - SHEET.MARGIN - BOTTOM_MM - HEAD_MM - FOOT_MM,
  }
}

/** Paper mm per plan px for `box` fitted to a plan sheet. */
export function reportScale(box: PlanBox, paper: PaperChoice): number {
  const { w, h } = reportSheetMm(paper)
  return Math.min(w / Math.max(box.w, 1), h / Math.max(box.h, 1))
}

type Grid = Pick<FloorPlan, "grid_width" | "grid_height">

/** The whole plan, in plan px. */
export function gridBox(plan: Grid): PlanBox {
  return { x: 0, y: 0, w: plan.grid_width * CELL, h: plan.grid_height * CELL }
}

/** `box` cut to the plan; null when it shows none of it. */
export function clampBox(box: PlanBox, plan: Grid): PlanBox | null {
  const g = gridBox(plan)
  const x0 = Math.max(g.x, box.x)
  const y0 = Math.max(g.y, box.y)
  const x1 = Math.min(g.w, box.x + box.w)
  const y1 = Math.min(g.h, box.y + box.h)
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** A room or area's sheet: the whole cells of its bounds plus the margin,
 * inside the plan (the server's area_crop). */
export function areaBox(
  area: AreaShape,
  plan: Grid & Pick<FloorPlan, "cell_mm">
): PlanBox {
  const b = shapeBounds(area, plan.cell_mm)
  const m = AREA_MARGIN_CELLS
  const x0 = Math.max(0, Math.floor(b.minX + 1e-6) - m)
  const y0 = Math.max(0, Math.floor(b.minY + 1e-6) - m)
  const x1 = Math.min(plan.grid_width, Math.ceil(b.maxX - 1e-6) + m)
  const y1 = Math.min(plan.grid_height, Math.ceil(b.maxY - 1e-6) + m)
  return {
    x: x0 * CELL,
    y: y0 * CELL,
    w: Math.max(1, x1 - x0) * CELL,
    h: Math.max(1, y1 - y0) * CELL,
  }
}

/** The rooms and areas a report can be cut to: the saved areas linked to
 * a room or a location, by name. */
export function reportAreas(
  shapes: readonly PlanShape[],
  isTemp: (id: string) => boolean
): { id: string; name: string; kind: "room" | "location" }[] {
  return shapes
    .filter(
      (s): s is AreaShape =>
        s.kind === "area" && !isTemp(s.id) && !!(s.room || s.location)
    )
    .map((s) => ({
      id: s.id,
      name: s.label || s.room?.name || s.location?.name || "Area",
      kind: s.room ? ("room" as const) : ("location" as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** One sheet's drawing, as posted. */
export interface ReportSheet {
  floor: string
  svg: string
  legend?: unknown
  cable_legend?: unknown
  area_legend?: unknown
}

export interface ReportOptions {
  scope: ReportScope
  include: readonly ReportInclude[]
  paper: PaperChoice
  /** `scope: "view"`: the box the screen shows (plan px). */
  box?: PlanBox
  /** `scope: "area"`: the room or area. */
  area?: string
  /** Tiles hidden on screen (left out of this floor's inventory). */
  hiddenTiles?: readonly string[]
}

/** The scope part of a report request - what the tables endpoint takes. */
export function reportScopeBody(o: ReportOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    scope: o.scope,
    include: [...o.include],
  }
  if (o.scope === "view" && o.box)
    body.box = [o.box.x, o.box.y, o.box.w, o.box.h].map(
      (v) => Math.round(v * 100) / 100
    )
  if (o.scope === "area" && o.area) body.area = o.area
  if (o.scope !== "building" && o.hiddenTiles?.length)
    body.hidden_tiles = [...o.hiddenTiles]
  return body
}

/** The whole report request: the scope, the paper and the sheets. */
export function reportBody(
  o: ReportOptions,
  sheets: readonly ReportSheet[]
): Record<string, unknown> {
  return {
    ...reportScopeBody(o),
    paper: { size: o.paper.size, orientation: o.paper.orientation },
    ...(o.include.includes("plan") ? { sheets } : {}),
  }
}

/** `svg` with `markup` drawn over everything in it. */
export function withOverlay(svg: string, markup: string): string {
  if (!markup) return svg
  const at = svg.lastIndexOf("</svg>")
  return at < 0 ? svg : svg.slice(0, at) + markup + svg.slice(at)
}

// ─── Another level of the building ──────────────────────────────────────

/** How the plan is drawn (the current floor's Display menu), for the
 * other levels of a building. */
export interface LevelLook {
  showCableLinks: boolean
  cableColorBy: CableColorBy
  bundleCables: boolean
  showCableLabels: boolean
  showZoneLabels: boolean
  showTrays: boolean
  objectSize: ObjectSize
  iconTiles: boolean
  /** Display > Tile icons (plan-svg.ts `tileIcons`). */
  tileIcons?: boolean
  /** Display > Camera FOV cones, and whether racks block them. */
  showFov?: boolean
  fovRacksBlock?: boolean
  /** Display > Callouts is Auto (plan-svg.ts `callouts`). */
  callouts?: boolean
}

/** A level of the building drawn for its sheet, from the server's rows -
 * the whole floor, its cables routed as the canvas routes them - with its
 * cables' and area types' legends. */
export async function drawLevel(
  floorId: string,
  paper: PaperChoice,
  look: LevelLook
): Promise<ReportSheet> {
  const [plan, contents, paths] = await Promise.all([
    api<FloorPlan>(`/api/floor-plans/${floorId}/`),
    api<FloorPlanContents>(`/api/floor-plans/${floorId}/contents/`),
    look.showCableLinks
      ? api<{ cables: FloorPlanCablePath[] }>(
          `/api/floor-plans/${floorId}/cable-paths/`
        ).then((r) => r.cables)
      : Promise.resolve([] as FloorPlanCablePath[]),
  ])
  const shapes = shapesOf(contents.areas, contents.labels)
  const box = gridBox(plan)
  const mmPerPx = reportScale(box, paper)
  const routes = new CableRouteCache().routes(paths, {
    trays: contents.trays,
    tiles: contents.tiles,
    ceilingMm: plan.ceiling_mm,
    areas: contents.raised_floors,
  })
  const stubs = cableStubs(paths, routes, contents.tiles, [
    plan.grid_width / 2,
    plan.grid_height / 2,
  ])
  const stubbed = new Set(stubs.map((s) => s.id))
  const shown = paths.filter((cp) => routes.has(cp.id) || stubbed.has(cp.id))
  const svg = planSvg({
    plan,
    tiles: contents.tiles,
    walls: contents.walls,
    trays: contents.trays,
    areas: contents.raised_floors,
    shapes,
    showZoneLabels: look.showZoneLabels,
    showTrays: look.showTrays,
    objectSize: look.objectSize,
    iconTiles: look.iconTiles,
    tileIcons: look.tileIcons ?? false,
    callouts: look.callouts ?? true,
    cameras: look.showFov
      ? { racksBlock: look.fovRacksBlock ?? false }
      : undefined,
    mmPerPx,
    cables: look.showCableLinks
      ? {
          paths: shown,
          routes,
          colorBy: look.cableColorBy,
          bundle: look.bundleCables,
          labels: look.showCableLabels,
          mmPerPx,
          stubs,
        }
      : undefined,
    fitContent: { paper, box, mmPerPx },
  })
  const key =
    look.showCableLinks && shown.length
      ? cableLegend(shown, look.cableColorBy, typePalette(paths), {
          bundles: look.bundleCables && hasSharedRuns(routes),
        })
      : null
  return {
    floor: floorId,
    svg,
    cable_legend: key ? cableLegendEntries(key) : null,
    area_legend: areaLegendEntries(shapes),
  }
}

// ─── CSV and XLSX ───────────────────────────────────────────────────────

const KIND: Record<string, string> = {
  rack: "Rack",
  cabinet: "Cabinet",
  device: "Device",
}

/** The report's tables as one table for the table export: the inventory,
 * then the cables, then the ports, each under its own header row. */
export function reportTable(data: FloorPlanReportTables): {
  columns: { header: string; id: string; get: () => string }[]
  rows: string[][]
} {
  const width = 11
  const pad = (cells: string[]) => [
    ...cells,
    ...Array<string>(Math.max(0, width - cells.length)).fill(""),
  ]
  const rows: string[][] = []
  const section = (title: string, head: string[]) => {
    if (rows.length) rows.push(pad([]))
    rows.push(pad([title]))
    rows.push(pad(head))
  }
  if (data.inventory) {
    section("Inventory", [
      "Group",
      "Name",
      "Kind",
      "Role",
      "Type",
      "Status",
      "Rack / cabinet",
      "Position",
      "Serial",
      "Asset tag",
      "Room",
    ])
    for (const g of data.inventory.groups)
      for (const r of g.rows)
        rows.push(
          pad([
            g.name,
            r.name,
            KIND[r.kind] ?? r.kind,
            r.role?.name ?? "",
            r.type,
            r.status?.name ?? "",
            r.holder,
            r.position,
            r.serial,
            r.asset_tag,
            r.room,
          ])
        )
    if (data.inventory.hidden_count)
      rows.push(pad(["Hidden", `${data.inventory.hidden_count} hidden`]))
  }
  if (data.cables) {
    const c = data.cables
    const byId = new Map(c.rows.map((r) => [r.id, r]))
    const ends = (es: (typeof c.rows)[number]["a"]) =>
      es
        .map((e) =>
          e.hidden ? "Hidden" : [e.device, e.port].filter(Boolean).join(" · ")
        )
        .filter(Boolean)
        .join(", ")
    section("Cables", [
      "Group",
      "Cable",
      "Type",
      "Status",
      "A end",
      "B end",
      "Route",
      "Computed (m)",
      "Stored",
      "Notes",
    ])
    for (const g of c.groups)
      for (const id of g.rows) {
        const r = byId.get(id)
        if (!r) continue
        rows.push(
          pad([
            g.name,
            r.label,
            r.type_display,
            r.status?.name ?? "",
            ends(r.a),
            ends(r.b),
            r.route,
            r.computed_m != null ? String(r.computed_m) : "",
            r.length != null ? `${r.length} ${r.length_unit}` : "",
            r.notes,
          ])
        )
      }
    if (c.hidden_count)
      rows.push(pad(["Hidden", `${c.hidden_count} cables hidden`]))
  }
  if (data.ports) {
    section("Ports", ["Device", "Port", "Cable", "Far end"])
    for (const r of data.ports.rows)
      rows.push(pad([r.device, r.port, r.cable, r.far]))
  }
  return {
    columns: Array.from({ length: width }, (_, i) => ({
      header: i === 0 ? data.title : "",
      id: String(i),
      get: () => "",
    })),
    rows,
  }
}
