import { useEffect, useRef, useState } from "react"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"
import { cn } from "@/lib/utils"

import { routeCable } from "./cable-route"
import type { Pt } from "./cable-route"
import { usePanZoom } from "./use-pan-zoom"

/** Default tray color when the user hasn't picked one — neutral gray. */
const TRAY_DEFAULT = "#71717a"

/** Imperative handle for parent-driven camera moves (fit, focus a tile). */
export interface FloorCanvasApi {
  fit: () => void
  focusTile: (tile: FloorPlanTile) => void
  /** Fit the view to a set of cell-unit points (e.g. a cable's route). */
  focusPoints: (points: Pt[]) => void
}

/** Pixel size of one grid cell in world coordinates. */
export const CELL = 40

/** A normalized palette entry — a FloorTileType or a DeviceRole. */
export interface PaletteEntry {
  key: string // "tt:<id>" | "role:<id>"
  kind: "tile_type" | "role"
  id: string
  name: string
  color: string
  icon: string
  defaultWidth: number
  defaultHeight: number
  isZone: boolean
  hasFov: boolean
}

export function tileFill(t: FloorPlanTile): string {
  return t.color || t.tile_type?.color || t.role_type?.color || "#a1a1aa"
}

export function tileName(t: FloorPlanTile): string {
  return t.label || t.linked?.name || ""
}

/** Zone tiles paint the background — they render under normal tiles and are
 * exempt from the no-overlap rule. */
export function tileIsZone(t: FloorPlanTile): boolean {
  return t.tile_type?.is_zone ?? false
}

export function tileHasFov(t: FloorPlanTile): boolean {
  return (t.tile_type?.has_fov || t.role_type?.has_fov) ?? false
}

/** Do two grid rects overlap? Zones never count. */
export function tilesCollide(
  a: { x: number; y: number; width: number; height: number },
  b: FloorPlanTile
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

/** First non-zone tile the candidate rect would stack on, or null. */
export function findCollision(
  tiles: FloorPlanTile[],
  rect: { x: number; y: number; width: number; height: number },
  ignoreId?: string
): FloorPlanTile | null {
  for (const t of tiles) {
    if (t.id === ignoreId || tileIsZone(t)) continue
    if (tilesCollide(rect, t)) return t
  }
  return null
}

/** The routed A↔B points (cell units) of a cable, through its trays. Empty
 * when either endpoint tile is missing. Shared by the render + camera focus. */
export function cableRoutePoints(
  cp: FloorPlanCablePath,
  trays: FloorPlanTray[],
  tiles: FloorPlanTile[]
): Pt[] {
  const a = cp.a_tiles[0] ? tileCentreCells(tiles, cp.a_tiles[0]) : null
  const b = cp.b_tiles[0] ? tileCentreCells(tiles, cp.b_tiles[0]) : null
  if (!a || !b) return []
  const polys = cp.tray_ids
    .map((tid) => trays.find((tr) => tr.id === tid)?.points)
    .filter((p): p is [number, number][] => !!p)
  return routeCable(a, b, polys)
}

/** Utilization tier → color (≤80 calm, 80–95 amber, >95 red). */
export function utilizationColor(ratio: number): string {
  if (ratio > 0.95) return "#ef4444"
  if (ratio > 0.8) return "#f59e0b"
  return "#10b981"
}

const CHECK_COLOR: Record<string, string> = {
  down: "#ef4444",
  stale: "#ef4444",
  degraded: "#f59e0b",
}

export interface CellPoint {
  x: number
  y: number
}

export interface FloorCanvasProps {
  plan: FloorPlan
  tiles: FloorPlanTile[]
  selectedId: string | null
  editable: boolean
  showGrid: boolean
  /** When set (editor place-mode), empty-grid drags paint a ghost rect and
   * release creates a tile instead of panning. */
  armed: PaletteEntry | null
  onSelect?: (id: string | null) => void
  onChangeTile?: (id: string, patch: Partial<FloorPlanTile>) => void
  /** Fired when a paint-drag completes (place-mode). */
  onCreateRect?: (rect: { x: number; y: number; w: number; h: number }) => void
  /** Viewer: tile clicked (also fired in editor on plain click, after select). */
  onOpenTile?: (tile: FloorPlanTile) => void
  /** Pointer entered/left a tile — `at` is screen-space relative to the canvas
   * wrapper, for anchoring the tile popover. Fired only on boundary crossings
   * (never per pointermove), so it can't regress canvas panning. */
  onHoverTile?: (
    tile: FloorPlanTile | null,
    at: { x: number; y: number } | null
  ) => void
  /** The element html-to-image snapshots for PNG export. */
  exportRef?: React.RefObject<HTMLDivElement | null>
  /** Live per-tile metrics from /state/ — paints rack utilization bars and
   * monitoring rings. */
  liveState?: FloorPlanLiveState | null
  /** Auto-size labels to fit their tile instead of a fixed 11px + ellipsis. */
  labelFit?: boolean
  /** Draw camera FOV cones for tiles whose type/role has them. */
  showFov?: boolean
  /** Draw the name label on background zone tiles (Cold aisle, Hot aisle…). */
  showZoneLabels?: boolean
  // ── Cable trays ────────────────────────────────────────────────────────
  /** "layout" edits tiles; "cable" draws/selects trays. */
  mode?: "layout" | "cable"
  trays?: FloorPlanTray[]
  showTrays?: boolean
  selectedTrayId?: string | null
  onSelectTray?: (id: string | null) => void
  /** Cable mode: an in-progress tray polyline (cell units, 0.5 steps). */
  drawPoints?: [number, number][]
  onAddDrawPoint?: (pt: [number, number]) => void
  onFinishDraw?: () => void
  /** Persist a moved/reshaped tray's new points (drag whole tray or a vertex). */
  onMoveTray?: (id: string, points: [number, number][]) => void
  /** Tray edit mode: hide all cables and make every tray reshapeable (drag
   * points, add/remove bends). A toggle, not per-tray. */
  trayEditMode?: boolean
  // ── Cable A↔B links ────────────────────────────────────────────────────
  cablePaths?: FloorPlanCablePath[]
  showCableLinks?: boolean
  /** Cables to highlight (a whole run can highlight several at once). */
  highlightCableIds?: string[]
  onSelectCable?: (id: string | null) => void
  /** Highlight several cables at once (right-click "trace cables here"). */
  onHighlightCables?: (ids: string[]) => void
  /** Parent-held ref to drive fit/focus from the header (search, fit btn). */
  apiRef?: React.RefObject<FloorCanvasApi | null>
  className?: string
}

type DragState =
  | { mode: "pan" }
  | { mode: "move"; id: string; grabDx: number; grabDy: number; moved: boolean }
  | { mode: "resize"; id: string; origin: CellPoint }
  | { mode: "paint"; start: CellPoint; end: CellPoint }
  | {
      mode: "tray-move"
      id: string
      grab: [number, number]
      orig: [number, number][]
      moved: boolean
    }
  | {
      mode: "tray-vertex"
      id: string
      index: number
      moved: boolean
      inserted?: boolean
    }

/**
 * The rendering core: one `<svg>` with a pan/zoom `<g>`, a cell `<pattern>`
 * grid, the background blueprint, and one `<g>` per tile. Orientation is
 * grid-honest — the rect stays axis-aligned (rotating swaps width/height at
 * the editor level) and only the icon rotates, so a rotated aisle still
 * occupies exactly the cells it claims.
 */
export function FloorCanvas({
  plan,
  tiles,
  selectedId,
  editable,
  showGrid,
  armed,
  onSelect,
  onChangeTile,
  onCreateRect,
  onOpenTile,
  onHoverTile,
  exportRef,
  liveState,
  labelFit = false,
  showFov = true,
  showZoneLabels = true,
  mode = "layout",
  trays = [],
  showTrays = true,
  selectedTrayId = null,
  onSelectTray,
  drawPoints,
  onAddDrawPoint,
  onFinishDraw,
  onMoveTray,
  trayEditMode = false,
  cablePaths = [],
  showCableLinks = false,
  highlightCableIds = [],
  onSelectCable,
  onHighlightCables,
  apiRef,
  className,
}: FloorCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<DragState | null>(null)
  const paintPreview = useRef<SVGRectElement>(null)
  const drawPreview = useRef<SVGPolylineElement>(null)
  // Live points of the tray being dragged/reshaped (null = none).
  const [trayDraft, setTrayDraft] = useState<{
    id: string
    points: [number, number][]
  } | null>(null)
  // Right-click menu: screen-relative position + what's under the cursor.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    tile: FloorPlanTile | null
    vertex?: { trayId: string; index: number }
  } | null>(null)
  const { t, setT, onWheel, startPan, movePan, endPan, toWorld, fitTo } =
    usePanZoom()

  const editing = trayEditMode
  const gw = plan.grid_width * CELL
  const gh = plan.grid_height * CELL
  const drawing = mode === "cable" && !!drawPoints

  // Fit the grid on first mount (and when the plan changes identity).
  useEffect(() => {
    fitTo(svgRef.current, gw, gh)
  }, [plan.id])

  // Parent-driven camera: fit the whole grid, or centre + zoom onto a tile.
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      fit: () => fitTo(svgRef.current, gw, gh),
      focusTile: (tile) => {
        const svg = svgRef.current
        if (!svg) return
        const rect = svg.getBoundingClientRect()
        const k = 1.4
        const tx = (tile.x + tile.width / 2) * CELL
        const ty = (tile.y + tile.height / 2) * CELL
        setT({ k, x: rect.width / 2 - tx * k, y: rect.height / 2 - ty * k })
      },
      focusPoints: (points) => {
        const svg = svgRef.current
        if (!svg || points.length === 0) return
        const rect = svg.getBoundingClientRect()
        const xs = points.map((p) => p[0] * CELL)
        const ys = points.map((p) => p[1] * CELL)
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)
        const w = Math.max(CELL, maxX - minX)
        const h = Math.max(CELL, maxY - minY)
        const k = Math.min(
          3,
          Math.max(
            0.2,
            Math.min((rect.width - 120) / w, (rect.height - 120) / h)
          )
        )
        setT({
          k,
          x: rect.width / 2 - ((minX + maxX) / 2) * k,
          y: rect.height / 2 - ((minY + maxY) / 2) * k,
        })
      },
    }
  }, [apiRef, fitTo, setT, gw, gh])

  const toCell = (e: React.PointerEvent): CellPoint => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    return {
      x: Math.max(0, Math.min(plan.grid_width - 1, Math.floor(w.x / CELL))),
      y: Math.max(0, Math.min(plan.grid_height - 1, Math.floor(w.y / CELL))),
    }
  }

  // Snap a pointer to the tray lattice (0.5 cell). Magnetically snaps to an
  // existing tray's vertex or segment when close, so trays connect exactly
  // where you draw into one.
  const toLattice = (e: React.PointerEvent): [number, number] => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    const cx = w.x / CELL
    const cy = w.y / CELL
    const round05 = (v: number, max: number) =>
      Math.max(0, Math.min(max, Math.round(v * 2) / 2))

    // Magnetic snap: nearest tray vertex or on-segment point within 0.5 cell.
    let best: [number, number] | null = null
    let bestD = 0.5
    for (const tray of trays) {
      const pts = tray.points
      for (const v of pts) {
        const d = Math.hypot(cx - v[0], cy - v[1])
        if (d < bestD) {
          bestD = d
          best = [v[0], v[1]]
        }
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const [sx, sy] = pts[i]
        const [ex, ey] = pts[i + 1]
        const dx = ex - sx
        const dy = ey - sy
        const len2 = dx * dx + dy * dy || 1e-9
        const proj = Math.max(
          0,
          Math.min(1, ((cx - sx) * dx + (cy - sy) * dy) / len2)
        )
        const px = sx + proj * dx
        const py = sy + proj * dy
        const d = Math.hypot(cx - px, cy - py)
        if (d < bestD) {
          bestD = d
          best = [px, py]
        }
      }
    }
    if (best)
      return [
        round05(best[0], plan.grid_width),
        round05(best[1], plan.grid_height),
      ]
    return [round05(cx, plan.grid_width), round05(cy, plan.grid_height)]
  }

  const paintRect = (a: CellPoint, b: CellPoint) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1,
  })

  const handleBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Cable mode: a click either drops a tray vertex (while drawing) or
    // deselects; panning still works via drag once not drawing.
    if (mode === "cable") {
      if (drawing) {
        onAddDrawPoint?.(toLattice(e))
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { mode: "pan" }
      startPan(e)
      onSelectTray?.(null)
      onSelectCable?.(null)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (editable && armed) {
      const c = toCell(e)
      drag.current = { mode: "paint", start: c, end: c }
    } else {
      drag.current = { mode: "pan" }
      startPan(e)
      onSelect?.(null)
      onSelectCable?.(null)
    }
  }

  const handleTileDown = (tile: FloorPlanTile, e: React.PointerEvent) => {
    if (e.button !== 0) return
    // In cable mode (or while editing a tray) tiles are inert.
    if (mode === "cable" || editing) return
    e.stopPropagation()
    if (!editable) {
      onOpenTile?.(tile)
      return
    }
    // Armed placement wins over background zones: clicking a zone with a
    // type armed paints on top of it instead of selecting the zone.
    if (armed && tileIsZone(tile)) {
      e.currentTarget.setPointerCapture(e.pointerId)
      const start = toCell(e)
      drag.current = { mode: "paint", start, end: start }
      return
    }
    onSelect?.(tile.id)
    const c = toCell(e)
    drag.current = {
      mode: "move",
      id: tile.id,
      grabDx: c.x - tile.x,
      grabDy: c.y - tile.y,
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handleResizeDown = (tile: FloorPlanTile, e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    drag.current = {
      mode: "resize",
      id: tile.id,
      origin: { x: tile.x, y: tile.y },
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  // Raw pointer position in cell units (no snapping) — for whole-tray moves.
  const toCellRaw = (e: React.PointerEvent): [number, number] => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    return [w.x / CELL, w.y / CELL]
  }

  // Grab a tray body → select it; in edit mode, arm a whole-tray move.
  const handleTrayDown = (tray: FloorPlanTray, e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelectTray?.(tray.id)
    if (!editable || !trayEditMode) return
    drag.current = {
      mode: "tray-move",
      id: tray.id,
      grab: toCellRaw(e),
      orig: tray.points.map((p) => [p[0], p[1]]),
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  // Grab a selected tray's vertex → reshape that point.
  const handleVertexDown = (
    tray: FloorPlanTray,
    index: number,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    drag.current = { mode: "tray-vertex", id: tray.id, index, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  // Click a segment's "+" handle → insert a bend there, then drag it.
  const handleInsertBend = (
    tray: FloorPlanTray,
    segIndex: number,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    const a = tray.points[segIndex]
    const b = tray.points[segIndex + 1]
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const points = [
      ...tray.points.slice(0, segIndex + 1),
      mid,
      ...tray.points.slice(segIndex + 1),
    ]
    setTrayDraft({ id: tray.id, points })
    drag.current = {
      mode: "tray-vertex",
      id: tray.id,
      index: segIndex + 1,
      moved: false,
      inserted: true,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  // Remove a vertex (keeps a tray at ≥2 points).
  const removeVertex = (trayId: string, index: number) => {
    const tray = trays.find((x) => x.id === trayId)
    if (!tray || tray.points.length <= 2) return
    onMoveTray?.(
      trayId,
      tray.points.filter((_, i) => i !== index)
    )
  }

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // Tray drawing: trail a dashed preview from the last vertex to the cursor.
    if (drawPoints) {
      const [cx, cy] = toLattice(e)
      const el = drawPreview.current
      if (el) {
        const pts = [...drawPoints, [cx, cy]]
          .map(([x, y]) => `${x * CELL},${y * CELL}`)
          .join(" ")
        el.setAttribute("points", pts)
      }
    }
    const d = drag.current
    if (!d) return
    if (d.mode === "pan") {
      movePan(e)
      return
    }
    const c = toCell(e)
    if (d.mode === "move") {
      const tile = tiles.find((x) => x.id === d.id)
      if (!tile) return
      const nx = Math.max(
        0,
        Math.min(plan.grid_width - tile.width, c.x - d.grabDx)
      )
      const ny = Math.max(
        0,
        Math.min(plan.grid_height - tile.height, c.y - d.grabDy)
      )
      if (nx !== tile.x || ny !== tile.y) {
        d.moved = true
        onChangeTile?.(d.id, { x: nx, y: ny })
      }
    } else if (d.mode === "resize") {
      const tile = tiles.find((x) => x.id === d.id)
      if (!tile) return
      const w = Math.max(1, c.x - d.origin.x + 1)
      const h = Math.max(1, c.y - d.origin.y + 1)
      if (w !== tile.width || h !== tile.height)
        onChangeTile?.(d.id, { width: w, height: h })
    } else if (d.mode === "tray-move") {
      // Translate every vertex by the cursor delta, snapped to the 0.5 grid.
      const [rx, ry] = toCellRaw(e)
      const dxc = Math.round((rx - d.grab[0]) * 2) / 2
      const dyc = Math.round((ry - d.grab[1]) * 2) / 2
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v))
      const pts = d.orig.map(([x, y]): [number, number] => [
        clamp(x + dxc, plan.grid_width),
        clamp(y + dyc, plan.grid_height),
      ])
      if (dxc !== 0 || dyc !== 0) d.moved = true
      setTrayDraft({ id: d.id, points: pts })
    } else if (d.mode === "tray-vertex") {
      // Move the grabbed vertex to the (magnetically snapped) cursor.
      const tray = trays.find((x) => x.id === d.id)
      if (!tray) return
      const base = trayDraft?.id === d.id ? trayDraft.points : tray.points
      const pts = base.map((p): [number, number] => [p[0], p[1]])
      pts[d.index] = toLattice(e)
      d.moved = true
      setTrayDraft({ id: d.id, points: pts })
    } else {
      d.end = c
      // Imperative preview — avoids re-rendering every tile per pointermove.
      const r = paintRect(d.start, d.end)
      const el = paintPreview.current
      if (el) {
        el.setAttribute("x", String(r.x * CELL))
        el.setAttribute("y", String(r.y * CELL))
        el.setAttribute("width", String(r.w * CELL))
        el.setAttribute("height", String(r.h * CELL))
        el.setAttribute("visibility", "visible")
      }
    }
  }

  const handleUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.mode === "pan") {
      endPan()
    } else if (d.mode === "paint") {
      paintPreview.current?.setAttribute("visibility", "hidden")
      onCreateRect?.(paintRect(d.start, d.end))
    } else if (d.mode === "tray-move" || d.mode === "tray-vertex") {
      // Persist a drag, OR a "+"-click that inserted a bend without dragging.
      const changed = d.moved || (d.mode === "tray-vertex" && d.inserted)
      if (changed && trayDraft?.id === d.id)
        onMoveTray?.(d.id, trayDraft.points)
      setTrayDraft(null)
    }
  }

  // Right-click → a small menu; hit-test which non-zone tile is under it.
  const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const wx = (e.clientX - rect.left - t.x) / t.k / CELL
    const wy = (e.clientY - rect.top - t.y) / t.k / CELL
    const hit = [...tiles]
      .reverse()
      .find(
        (tl) =>
          !tileIsZone(tl) &&
          wx >= tl.x &&
          wx < tl.x + tl.width &&
          wy >= tl.y &&
          wy < tl.y + tl.height
      )
    setCtxMenu({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      tile: hit ?? null,
    })
  }

  // Hover → screen-space point for the popover anchor. Same coordinate trick as
  // the context menu above: measure against the svg's rect so the point lands in
  // the wrapper's absolute space, and it stays correct through pan/zoom because
  // it's re-derived per event rather than cached.
  const reportHover = (tile: FloorPlanTile, e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    // Suppress while dragging/panning/drawing — a popover chasing the cursor
    // mid-drag is noise.
    if (drag.current || drawing) return
    onHoverTile?.(tile, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // Cables whose A↔B run touches a tile — for "trace cables here".
  const cablesTouching = (tileId: string) =>
    cablePaths
      .filter(
        (cp) => cp.a_tiles.includes(tileId) || cp.b_tiles.includes(tileId)
      )
      .map((cp) => cp.id)

  return (
    <div
      ref={exportRef}
      // Marks the canvas so overlays (the tile popover) can tell a click on the
      // plan — which their own select/pin logic already handles — from a genuine
      // click elsewhere in the app.
      data-floor-canvas=""
      className={cn(
        "relative h-full w-full overflow-hidden bg-background",
        className
      )}
    >
      <svg
        ref={svgRef}
        className="h-full w-full touch-none text-foreground select-none"
        onWheel={onWheel}
        onPointerDown={(e) => {
          setCtxMenu(null)
          handleBackgroundDown(e)
        }}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerLeave={handleUp}
        onDoubleClick={() => drawing && onFinishDraw?.()}
        onContextMenu={handleContextMenu}
        style={{
          cursor: (armed && editable) || drawing ? "crosshair" : "grab",
        }}
      >
        <defs>
          <pattern
            id="fp-grid"
            width={CELL}
            height={CELL}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${CELL} 0 L 0 0 0 ${CELL}`}
              fill="none"
              className="stroke-border"
              strokeWidth={1}
            />
          </pattern>
        </defs>
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {/* Floor surface */}
          <rect width={gw} height={gh} className="fill-muted/30" rx={4} />
          {plan.background_image && (
            <image
              href={plan.background_image}
              width={gw}
              height={gh}
              opacity={plan.background_opacity / 100}
              preserveAspectRatio="none"
            />
          )}
          {showGrid && (
            <rect
              width={gw}
              height={gh}
              fill="url(#fp-grid)"
              pointerEvents="none"
            />
          )}
          <rect
            width={gw}
            height={gh}
            fill="none"
            className="stroke-border"
            strokeWidth={2}
            rx={4}
            pointerEvents="none"
          />

          {/* Zones first (background), then normal tiles, then FOV cones. */}
          {[
            ...tiles.filter(tileIsZone),
            ...tiles.filter((tl) => !tileIsZone(tl)),
          ].map((tile) => (
            <TileShape
              key={tile.id}
              tile={tile}
              selected={tile.id === selectedId}
              editable={editable}
              labelFit={labelFit}
              showZoneLabels={showZoneLabels}
              live={liveState?.tiles[tile.id]}
              onPointerDown={(e) => handleTileDown(tile, e)}
              onResizeDown={(e) => handleResizeDown(tile, e)}
              // In Cables mode a double-click finishes a tray draw — don't also
              // open the tile's deep-view underneath it.
              onDoubleClick={() => {
                if (mode !== "cable") onOpenTile?.(tile)
              }}
              onPointerEnter={(e) => reportHover(tile, e)}
              onPointerLeave={() => onHoverTile?.(null, null)}
            />
          ))}

          {showFov &&
            tiles
              .filter(
                (tl) =>
                  tileHasFov(tl) &&
                  tl.fov_distance &&
                  (tl.fov_ptz || tl.fov_deg)
              )
              .map((tl) => <FovCone key={`fov-${tl.id}`} tile={tl} />)}

          {/* Cable trays — drawn above tiles so the run reads on a builder's
              print. Clickable only in cable mode so layout editing is undisturbed. */}
          {showTrays &&
            trays.map((tray) => {
              // In edit mode the SELECTED tray shows drag handles + "+" bend
              // inserters; all trays are draggable/selectable.
              const isEditing = trayEditMode && tray.id === selectedTrayId
              return (
                <TrayShape
                  key={tray.id}
                  tray={
                    trayDraft?.id === tray.id
                      ? { ...tray, points: trayDraft.points }
                      : tray
                  }
                  selected={tray.id === selectedTrayId}
                  interactive={mode === "cable" && !drawing}
                  editable={
                    editable && mode === "cable" && !drawing && trayEditMode
                  }
                  editing={isEditing}
                  dimmed={false}
                  onPointerDown={(e) => handleTrayDown(tray, e)}
                  onDoubleClick={() => onSelectTray?.(tray.id)}
                  onVertexDown={(index, e) => handleVertexDown(tray, index, e)}
                  onInsertBend={(seg, e) => handleInsertBend(tray, seg, e)}
                  onVertexContext={(index, ev) => {
                    ev.preventDefault()
                    ev.stopPropagation()
                    const rect = svgRef.current?.getBoundingClientRect()
                    if (!rect) return
                    setCtxMenu({
                      x: ev.clientX - rect.left,
                      y: ev.clientY - rect.top,
                      tile: null,
                      vertex: { trayId: tray.id, index },
                    })
                  }}
                />
              )
            })}

          {/* Cable A↔B links — routed THROUGH the cable's trays (falls back to
              a straight line when the cable has no trays). The highlighted
              cable renders LAST so it sits on top of any it shares a path
              with; the rest dim so the traced run stands out. Clickable in
              any mode when the links overlay is on — no Cables mode needed. */}
          {/* Edit mode hides cables entirely so trays are free to grab. */}
          {showCableLinks &&
            !trayEditMode &&
            [...cablePaths]
              .sort(
                (a, b) =>
                  (highlightCableIds.includes(a.id) ? 1 : 0) -
                  (highlightCableIds.includes(b.id) ? 1 : 0)
              )
              .map((cp) => {
                const route = cableRoutePoints(cp, trays, tiles)
                if (route.length < 2) return null
                const hi = highlightCableIds.includes(cp.id)
                return (
                  <CableLink
                    key={cp.id}
                    route={route}
                    color={cp.color}
                    label={cp.label}
                    type={cp.type}
                    highlighted={hi}
                    dimmed={highlightCableIds.length > 0 && !hi}
                    interactive
                    onSelect={() => onSelectCable?.(hi ? null : cp.id)}
                  />
                )
              })}

          {/* In-progress tray preview (imperatively positioned) */}
          {drawing && (
            <polyline
              ref={drawPreview}
              points=""
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeLinejoin="round"
              strokeLinecap="round"
              pointerEvents="none"
            />
          )}

          {/* Paint-mode ghost rect (imperatively positioned) */}
          <rect
            ref={paintPreview}
            visibility="hidden"
            rx={6}
            fill={armed?.color || "#a1a1aa"}
            fillOpacity={0.15}
            stroke={armed?.color || "#a1a1aa"}
            strokeDasharray="6 3"
            pointerEvents="none"
          />
        </g>
      </svg>

      {/* Right-click menu — a small, extensible action list. */}
      {ctxMenu && (
        <div
          className="absolute z-20 min-w-40 overflow-hidden rounded-md border border-border bg-popover py-1 text-[13px] shadow-md"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ctxMenu.vertex && (
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left hover:bg-muted/60"
              onClick={() => {
                removeVertex(ctxMenu.vertex!.trayId, ctxMenu.vertex!.index)
                setCtxMenu(null)
              }}
            >
              Remove bend
            </button>
          )}
          {ctxMenu.tile && (
            <>
              <div className="truncate px-3 py-1 text-[11px] text-muted-foreground">
                {tileName(ctxMenu.tile) ||
                  ctxMenu.tile.tile_type?.name ||
                  ctxMenu.tile.role_type?.name ||
                  "Tile"}
              </div>
              {onHighlightCables &&
                cablesTouching(ctxMenu.tile.id).length > 0 && (
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-muted/60"
                    onClick={() => {
                      onHighlightCables(cablesTouching(ctxMenu.tile!.id))
                      setCtxMenu(null)
                    }}
                  >
                    Trace cables here
                  </button>
                )}
              {ctxMenu.tile.linked && onOpenTile && (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-muted/60"
                  onClick={() => {
                    onOpenTile(ctxMenu.tile!)
                    setCtxMenu(null)
                  }}
                >
                  Open{" "}
                  {ctxMenu.tile.linked.kind === "floorplan"
                    ? "plan"
                    : ctxMenu.tile.linked.kind}
                </button>
              )}
              <div className="my-1 h-px bg-border" />
            </>
          )}
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left hover:bg-muted/60"
            onClick={() => {
              fitTo(svgRef.current, gw, gh)
              setCtxMenu(null)
            }}
          >
            Fit to view
          </button>
          {highlightCableIds.length > 0 && (
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left hover:bg-muted/60"
              onClick={() => {
                onSelectCable?.(null)
                setCtxMenu(null)
              }}
            >
              Clear trace
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A tray run: a subtle hollow channel (no bright core — cables show *inside*
 * it when traced). Selected shows vertex dots; editing shows drag handles plus
 * per-segment "+" bend-inserters. */
function TrayShape({
  tray,
  selected,
  interactive,
  editable,
  editing,
  dimmed,
  onPointerDown,
  onDoubleClick,
  onVertexDown,
  onInsertBend,
  onVertexContext,
}: {
  tray: FloorPlanTray
  selected: boolean
  interactive: boolean
  editable: boolean
  editing: boolean
  dimmed: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
  onVertexDown: (index: number, e: React.PointerEvent) => void
  onInsertBend: (segIndex: number, e: React.PointerEvent) => void
  onVertexContext: (index: number, e: React.MouseEvent) => void
}) {
  if (tray.points.length < 2) return null
  const color = tray.color || TRAY_DEFAULT
  const pts = tray.points.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
  const mid = tray.points[Math.floor(tray.points.length / 2)]
  const count = tray.cables.length
  // Show handles when editing this tray, or (for a quick reshape) when it's
  // the plain selection.
  const showHandles = editable && (editing || selected)

  return (
    <g
      opacity={dimmed ? 0.3 : 1}
      onPointerDown={interactive ? onPointerDown : undefined}
      onDoubleClick={interactive ? onDoubleClick : undefined}
      style={{
        cursor: interactive ? (editable ? "move" : "pointer") : "default",
      }}
    >
      <title>
        {tray.name}
        {tray.kind ? ` · ${tray.kind}` : ""} · {count} cable
        {count === 1 ? "" : "s"}
        {interactive && !editing ? " · double-click to edit shape" : ""}
      </title>
      {/* Channel body — wide + faint. No centerline: the middle stays empty
          so a traced cable reads as running inside the tray. */}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeOpacity={editing ? 0.6 : selected ? 0.5 : 0.3}
        strokeWidth={editing || selected ? 11 : 10}
        strokeLinejoin="round"
        strokeLinecap="round"
        pointerEvents={interactive ? "stroke" : "none"}
      />
      {/* Per-segment "+" handles to insert a bend (edit mode). */}
      {editing &&
        tray.points.slice(0, -1).map(([x, y], i) => {
          const [nx, ny] = tray.points[i + 1]
          const cx = ((x + nx) / 2) * CELL
          const cy = ((y + ny) / 2) * CELL
          return (
            <g
              key={`add-${i}`}
              style={{ cursor: "copy" }}
              onPointerDown={(e) => onInsertBend(i, e)}
            >
              <title>Insert a bend</title>
              <circle
                cx={cx}
                cy={cy}
                r={5}
                fill="var(--background)"
                stroke={color}
                strokeWidth={1.25}
                strokeDasharray="2 1.5"
              />
              <path
                d={`M ${cx - 2.5} ${cy} H ${cx + 2.5} M ${cx} ${cy - 2.5} V ${cy + 2.5}`}
                stroke={color}
                strokeWidth={1.25}
                strokeLinecap="round"
                pointerEvents="none"
              />
            </g>
          )
        })}
      {showHandles &&
        tray.points.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * CELL}
            cy={y * CELL}
            r={editing ? 5 : 4.5}
            fill={editing ? color : "var(--background)"}
            fillOpacity={editing ? 0.9 : 1}
            stroke={color}
            strokeWidth={1.75}
            style={{ cursor: "grab" }}
            pointerEvents="auto"
            onPointerDown={(e) => onVertexDown(i, e)}
            onContextMenu={editing ? (e) => onVertexContext(i, e) : undefined}
          />
        ))}
      <text
        x={mid[0] * CELL}
        y={mid[1] * CELL - 9}
        textAnchor="middle"
        fontSize={10}
        fill={color}
        fontWeight={600}
        pointerEvents="none"
      >
        {tray.name}
        {count > 0 ? ` · ${count}` : ""}
      </text>
    </g>
  )
}

/** Centre point of a tile in CELL units (for the tray router). */
function tileCentreCells(tiles: FloorPlanTile[], tileId: string): Pt | null {
  const t = tiles.find((x) => x.id === tileId)
  if (!t) return null
  return [t.x + t.width / 2, t.y + t.height / 2]
}

/** One cable's physical run, already routed through its trays (cell units).
 * Rendered as a polyline through the tray channels with a dot at each end. */
function CableLink({
  route,
  color: rawColor,
  label,
  type,
  highlighted,
  dimmed,
  interactive,
  onSelect,
}: {
  route: Pt[]
  color: string
  label: string
  type: string
  highlighted: boolean
  dimmed: boolean
  interactive: boolean
  onSelect: () => void
}) {
  if (route.length < 2) return null
  const color = rawColor || "#0ea5e9"
  const pts = route.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
  const a = route[0]
  const b = route[route.length - 1]
  const opacity = dimmed ? 0.2 : 1
  return (
    <g
      opacity={opacity}
      onPointerDown={
        interactive
          ? (e) => {
              e.stopPropagation()
              onSelect()
            }
          : undefined
      }
      style={{ cursor: interactive ? "pointer" : "default" }}
    >
      <title>
        {label}
        {type ? ` · ${type}` : ""} (A↔B)
      </title>
      {interactive && (
        <polyline
          points={pts}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
        />
      )}
      {/* Highlighted run gets a soft halo so it reads clearly on top of the
          cables it shares a path with. */}
      {highlighted && (
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeOpacity={0.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={highlighted ? 3.5 : 1.5}
        strokeOpacity={highlighted ? 1 : 0.6}
        strokeDasharray={highlighted ? "7 5" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      >
        {highlighted && (
          <animate
            attributeName="stroke-dashoffset"
            from="24"
            to="0"
            dur="0.7s"
            repeatCount="indefinite"
          />
        )}
      </polyline>
      {[a, b].map((p, i) => (
        <circle
          key={i}
          cx={p[0] * CELL}
          cy={p[1] * CELL}
          r={highlighted ? 5.5 : 3.5}
          fill={color}
          stroke="var(--background)"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      ))}
    </g>
  )
}

/** Native hover tooltip text: name · type · linked · (rack) used-U/%. */
function tileTooltip(
  tile: FloorPlanTile,
  live?: FloorPlanLiveState["tiles"][string]
): string {
  const parts = [
    tileName(tile) || tile.tile_type?.name || tile.role_type?.name || "Tile",
  ]
  const type = tile.tile_type?.name ?? tile.role_type?.name
  if (type && type !== parts[0]) parts.push(type)
  if (tile.status) parts.push(tile.status)
  if (tile.linked) parts.push(`→ ${tile.linked.kind} ${tile.linked.name}`)
  if (live?.kind === "rack" && live.u_height > 0) {
    parts.push(
      `${live.used_units}/${live.u_height}U (${Math.round(
        (live.used_units / live.u_height) * 100
      )}%)`
    )
  }
  if (live?.check) parts.push(`check: ${live.check}`)
  return parts.join(" · ")
}

/** Label sizing: fixed 11px + ellipsis, or (labelFit) scaled to FILL the
 * tile — as big as the footprint allows, bounded by width per glyph and by
 * tile height (leaving room for the utilization bar). */
function labelLayout(name: string, w: number, h: number, labelFit: boolean) {
  if (!labelFit) {
    const maxChars = Math.max(3, Math.floor(w / 7))
    return {
      fontSize: 11,
      text: name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name,
    }
  }
  // ~0.62em average glyph width for the system sans.
  const widthFit = (w - 8) / (Math.max(1, name.length) * 0.62)
  return { fontSize: Math.max(5, Math.min(h * 0.55, widthFit)), text: name }
}

function TileShape({
  tile,
  selected,
  editable,
  labelFit,
  showZoneLabels = true,
  live,
  onPointerDown,
  onResizeDown,
  onDoubleClick,
  onPointerEnter,
  onPointerLeave,
}: {
  tile: FloorPlanTile
  selected: boolean
  editable: boolean
  labelFit: boolean
  showZoneLabels?: boolean
  live?: FloorPlanLiveState["tiles"][string]
  onPointerDown: (e: React.PointerEvent) => void
  onResizeDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
  /** Hover in/out — fires only on tile boundary crossings, so the popover
   * costs nothing per pointermove (see the note on handleMove). */
  onPointerEnter?: (e: React.PointerEvent) => void
  onPointerLeave?: (e: React.PointerEvent) => void
}) {
  const w = tile.width * CELL
  const h = tile.height * CELL
  const fill = tileFill(tile)
  const name = tileName(tile)
  const zone = tileIsZone(tile)
  const dashed = tile.status === "planned" || tile.status === "reserved"
  const showLabel = !!name
  const label = showLabel ? labelLayout(name, w, h, labelFit) : null

  // Live monitoring: down/degraded overrides the stroke so a rack going red
  // is visible at any zoom.
  const check = live?.check ?? null
  const checkColor = check ? CHECK_COLOR[check] : undefined
  const rackLive = live?.kind === "rack" ? live : null
  const utilization =
    rackLive && rackLive.u_height > 0
      ? rackLive.used_units / rackLive.u_height
      : null

  if (zone) {
    // Zones: soft area tint under everything, label pinned top-left, no
    // selection handles beyond the outline.
    return (
      <g
        transform={`translate(${tile.x * CELL},${tile.y * CELL})`}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        style={{ cursor: editable ? "move" : "pointer" }}
      >
        <rect
          width={w}
          height={h}
          rx={4}
          fill={fill}
          fillOpacity={0.14}
          stroke={fill}
          strokeOpacity={selected ? 0.9 : 0.35}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray="4 4"
        />
        {showLabel && showZoneLabels && (
          <text
            x={6}
            y={14}
            fontSize={10}
            fill={fill}
            pointerEvents="none"
            fontWeight={500}
          >
            {name}
          </text>
        )}
        {selected && editable && (
          <rect
            x={w - 7}
            y={h - 7}
            width={12}
            height={12}
            rx={2}
            className="fill-background stroke-foreground/60"
            strokeWidth={1.5}
            style={{ cursor: "nwse-resize" }}
            onPointerDown={onResizeDown}
          />
        )}
      </g>
    )
  }

  return (
    <g
      transform={`translate(${tile.x * CELL},${tile.y * CELL})`}
      opacity={tile.status === "decommissioning" ? 0.55 : 1}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ cursor: editable ? "move" : "pointer" }}
      // No <title>: that IS the native browser tooltip, which the rich popover
      // replaces. The same summary stays as the accessible name, so screen
      // readers lose nothing.
      role="img"
      aria-label={tileTooltip(tile, live)}
    >
      <rect
        width={w}
        height={h}
        rx={6}
        fill={fill}
        fillOpacity={0.18}
        stroke={checkColor ?? fill}
        strokeWidth={selected ? 2.5 : checkColor ? 2 : 1.25}
        strokeDasharray={dashed ? "6 3" : undefined}
      />
      {/* Icons live in the palette rail only — tiles stay clean: color,
          label, and live state. */}
      {label && (
        <text
          x={w / 2}
          y={h / 2 + label.fontSize / 3}
          textAnchor="middle"
          fontSize={label.fontSize}
          fill="currentColor"
          pointerEvents="none"
        >
          {label.text}
        </text>
      )}
      {utilization !== null && (
        // Rack tiles: a thin utilization bar along the bottom edge.
        <g pointerEvents="none">
          <rect
            x={3}
            y={h - 7}
            width={w - 6}
            height={4}
            rx={2}
            className="fill-foreground/10"
          />
          <rect
            x={3}
            y={h - 7}
            width={Math.max(2, (w - 6) * Math.min(1, utilization))}
            height={4}
            rx={2}
            fill={utilizationColor(utilization)}
          />
          {w >= CELL * 2 && (
            <text
              x={w - 4}
              y={h - 10}
              textAnchor="end"
              fontSize={8}
              fill="currentColor"
              opacity={0.7}
              className="num"
            >
              {Math.round(utilization * 100)}%
            </text>
          )}
        </g>
      )}
      {tile.linked && (
        <circle
          cx={w - 7}
          cy={7}
          r={3.5}
          fill={checkColor ?? fill}
          data-linked="1"
        />
      )}
      {selected && editable && (
        <rect
          x={w - 7}
          y={h - 7}
          width={12}
          height={12}
          rx={2}
          className="fill-background stroke-foreground/60"
          strokeWidth={1.5}
          style={{ cursor: "nwse-resize" }}
          onPointerDown={onResizeDown}
        />
      )}
    </g>
  )
}

/** Camera field-of-view wedge: direction (0° = up, clockwise), angle,
 * distance in cells. Rendered above tiles, ignores pointer events. */
function FovCone({ tile }: { tile: FloorPlanTile }) {
  const angle = Math.min(360, Math.max(10, tile.fov_deg ?? 90))
  const dist = (tile.fov_distance ?? 3) * CELL
  const dir = tile.fov_direction ?? 0
  // The cone emits from the tile's anchor — a corner or the center
  // (the dice-5 picker in the inspector).
  const ax = tile.fov_anchor.includes("l")
    ? 0
    : tile.fov_anchor.includes("r")
      ? 1
      : 0.5
  const ay = tile.fov_anchor.includes("t")
    ? 0
    : tile.fov_anchor.includes("b")
      ? 1
      : 0.5
  const cx = (tile.x + tile.width * ax) * CELL
  const cy = (tile.y + tile.height * ay) * CELL
  const fill = tileFill(tile)

  // PTZ: the camera can sweep the whole circle — draw a 360° ring instead
  // of a fixed wedge.
  if (tile.fov_ptz) {
    return (
      <circle
        cx={cx}
        cy={cy}
        r={dist}
        fill={fill}
        fillOpacity={0.08}
        stroke={fill}
        strokeOpacity={0.45}
        strokeWidth={1}
        strokeDasharray="4 3"
        pointerEvents="none"
      />
    )
  }

  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180
  const a0 = rad(dir - angle / 2)
  const a1 = rad(dir + angle / 2)
  const x0 = cx + dist * Math.cos(a0)
  const y0 = cy + dist * Math.sin(a0)
  const x1 = cx + dist * Math.cos(a1)
  const y1 = cy + dist * Math.sin(a1)
  const largeArc = angle > 180 ? 1 : 0

  return (
    <path
      d={`M ${cx} ${cy} L ${x0} ${y0} A ${dist} ${dist} 0 ${largeArc} 1 ${x1} ${y1} Z`}
      fill={fill}
      fillOpacity={0.12}
      stroke={fill}
      strokeOpacity={0.45}
      strokeWidth={1}
      strokeDasharray="4 3"
      pointerEvents="none"
    />
  )
}
