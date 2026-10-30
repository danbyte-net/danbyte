import { useCallback, useEffect, useRef, useState } from "react"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorPlanPlaceable,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
} from "@/lib/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PointerMenu } from "@/components/pointer-menu"
import { cn } from "@/lib/utils"

import type { Pt } from "./cable-route"
import { CELL, tileHasFov, tileIsZone, tileName } from "./canvas-geometry"
import type { CellPoint, PaletteEntry } from "./canvas-geometry"
import { FovCone, TileShape } from "./tile-layer"
import { tileFill } from "./tile-paint"
import type { ColorBy, RackFigures } from "./tile-paint"
import {
  AreaShapeView,
  BoxHandles,
  DrawPreview,
  LabelShapeView,
  VertexHandles,
} from "./shape-layer"
import { PLACE_MIME } from "./placement"
import {
  boxBounds,
  byZ,
  labelBox,
  pointInBox,
  pointInPolygon,
  polygonPatch,
  shapeBounds,
  tileBox,
  tileQuarter,
} from "./shapes"
import type { PlanShape } from "./shapes"
import { TrayShape } from "./tray-layer"
import { CableLayer } from "./cable-layer"
import type { CableAnchor, CableHoverHit } from "./cable-layer"
import type { CableColorBy, CableRoute } from "./cable-draw"
import { usePanZoom } from "./use-pan-zoom"
import { useShapeGestures } from "./use-shape-gestures"
import type { ShapeTool } from "./use-shape-gestures"
import type { NewAreaGeometry } from "./use-shape-edits"
import { WallShape } from "./wall-layer"

// The plan's geometry and its rules live in canvas-geometry.ts and each layer
// in its own module; the canvas re-exports what its callers import from here.
export {
  CELL,
  GUTTER,
  cableRoutePoints,
  findCollision,
  tileHasFov,
  tileIsZone,
  tileName,
  tilesCollide,
} from "./canvas-geometry"
export type { CellPoint, PaletteEntry } from "./canvas-geometry"
export { tileFill }

/** Rows shown but locked here (a live view's edge rows) draw faded. */
const LOCKED_OPACITY = 0.5
/** Stable empties, so the memoised cable layer keeps its props. */
const NO_CABLES: FloorPlanCablePath[] = []
const NO_IDS: string[] = []
const NO_ROUTES: ReadonlyMap<string, CableRoute> = new Map()

/** Imperative handle for parent-driven camera moves (fit, focus a tile). */
export interface FloorCanvasApi {
  fit: () => void
  focusTile: (tile: FloorPlanTile, zoom?: number) => void
  /** Fit the view to a set of cell-unit points (e.g. a cable's route). */
  focusPoints: (points: Pt[]) => void
  /** The polygon being drawn: close it (Enter), take back its last point
   * (Backspace), or drop it (Esc). `drawingShape` says whether one is. */
  finishPolygon?: () => boolean
  popPoint?: () => void
  cancelDraw?: () => void
  drawingShape?: () => boolean
  /** The cell point at the middle of the view, and the one under the
   * pointer while it is over the plan (the Place picker's "near"). */
  centerCell?: () => Pt
  pointerCell?: () => Pt | null
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
  /** Layout QoL: Shift- or Ctrl/⌘-click toggles a tile in the
   * multi-selection. */
  multiSelectedIds?: ReadonlySet<string>
  onToggleSelect?: (id: string) => void
  /** Dragging a tile of a multi-selection moves the whole selection by
   * whole cells; false when it can't go there (it stays put). */
  onMoveSelection?: (dx: number, dy: number) => boolean
  /** A tile drag (move or resize) starts and ends: the page makes the
   * edits in between one undo step. */
  onGestureStart?: () => void
  onGestureEnd?: () => void
  /** Layout QoL: Shift-drag on empty grid sweeps a marquee; release reports
   * the swept rect (cell units) so the page can select what it covers. */
  onMarquee?: (rect: { x: number; y: number; w: number; h: number }) => void
  onChangeTile?: (id: string, patch: Partial<FloorPlanTile>) => void
  /** Fired when a paint-drag completes (place-mode). */
  onCreateRect?: (rect: { x: number; y: number; w: number; h: number }) => void
  /** Open a tile: a double-click, the context menu, and a viewer's click
   * unless `onClickTile` takes it. */
  onOpenTile?: (tile: FloorPlanTile) => void
  /** Viewer: a single click on a tile, in place of opening it. */
  onClickTile?: (tile: FloorPlanTile) => void
  /** Pointer entered/left a tile - `at` is screen-space relative to the canvas
   * wrapper, for anchoring the tile popover. Fired only on boundary crossings
   * (never per pointermove), so it can't regress canvas panning. */
  onHoverTile?: (
    tile: FloorPlanTile | null,
    at: { x: number; y: number } | null
  ) => void
  /** The element html-to-image snapshots for PNG export. */
  exportRef?: React.RefObject<HTMLDivElement | null>
  /** Live per-tile metrics from /state/ - paints rack utilization bars,
   * cabinet device counts and monitoring rings. */
  liveState?: FloorPlanLiveState | null
  /** What rack tiles are coloured by (#247, `tile-paint.ts`). `type`, the
   * default, is the plan as it always looked. */
  colorBy?: ColorBy
  /** Each rack tile's figures, by tile id (`plan-racks.ts`
   * `tileRackFigures`). Without it a rack reads its live state alone. */
  rackFigures?: ReadonlyMap<string, RackFigures>
  /** Tiles outlined as pointed at - a row hovered in the rack table. */
  highlightTileIds?: ReadonlySet<string>
  /** Tiles faded - racks the rack table's filter leaves out. */
  dimTileIds?: ReadonlySet<string>
  /** Drawn over the plan inside the export area, so the PNG carries it -
   * the Color by legend. */
  overlay?: React.ReactNode
  /** Auto-size labels to fit their tile instead of a fixed 11px + ellipsis. */
  labelFit?: boolean
  /** Draw camera FOV cones for tiles whose type/role has them. */
  showFov?: boolean
  /** Draw the name label on background zone tiles (Cold aisle, Hot aisle…). */
  showZoneLabels?: boolean
  /** Outline photo tiles that are not selected. */
  photoOutlines?: boolean
  // ── Raised-floor areas (Structure mode) ────────────────────────────────
  /** Raised-floor rectangles, drawn UNDER every tile in all modes. */
  raisedFloors?: {
    id: string
    x: number
    y: number
    width: number
    height: number
    plenum_mm: number
    label: string
    color: string
  }[]
  selectedAreaId?: string | null
  /** Structure mode: an area outline was clicked. */
  onSelectArea?: (id: string | null) => void
  /** Structure mode: an area was dragged/resized - persist its new rect. */
  onAreaRectChange?: (
    id: string,
    rect: { x: number; y: number; width: number; height: number }
  ) => void
  // ── Walls (Structure mode) ─────────────────────────────────────────────
  /** Wall polylines with door openings - drawn in ALL modes; interactive
   * (select / move / place doors) only in Structure mode. */
  walls?: FloorPlanWall[]
  selectedWallId?: string | null
  onSelectWall?: (id: string | null) => void
  /** Structure mode: a whole-wall drag ended - persist the translated points. */
  onMoveWall?: (id: string, points: [number, number][]) => void
  /** "Add door" is armed: the next click on a wall segment drops an opening. */
  doorArmed?: boolean
  /** Door placement: segment `seg` of wall `id` was clicked, `at` cells along it. */
  onPlaceDoor?: (id: string, seg: number, at: number) => void
  // ── Cable trays ────────────────────────────────────────────────────────
  /** "layout" edits tiles; "cable" draws/selects trays. */
  mode?: "layout" | "cable" | "structure"
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
  /** Each cable's route (use-cable-routes.ts), worked out once per change
   * of the plan's contents - never per frame. */
  cableRoutes?: ReadonlyMap<string, CableRoute>
  /** What the cables are coloured by. */
  cableColorBy?: CableColorBy
  /** Cable names along the runs, up close. */
  showCableLabels?: boolean
  /** Runs sharing a stretch draw as one stroke with a count where their
   * lanes would not read. */
  bundleCables?: boolean
  /** Pointer or keyboard on a cable or a bundle - `at` in the wrapper's
   * px, for the cable popover. */
  onHoverCable?: (
    hit: CableHoverHit | null,
    at: { x: number; y: number } | null
  ) => void
  /** Parent-held ref to drive fit/focus from the header (search, fit btn). */
  apiRef?: React.RefObject<FloorCanvasApi | null>
  /** Drawn in world px over the floor and under the grid - the plan's CAD
   * drawing (cad-layer.tsx). */
  underlay?: React.ReactNode
  /** Drawn in world px over everything else - calibration marks. */
  worldOverlay?: React.ReactNode
  /** Point-pick mode (drawing calibration): a click anywhere reports its
   * world px point instead of selecting or painting; a drag still pans. */
  onPickPoint?: (pt: { x: number; y: number }) => void
  // ── Areas and labels; free placement ─────────────────────────────────
  /** Areas and labels as shown (hidden ones left out). Areas draw over the
   * zones and under the tiles, labels over the tiles. */
  shapes?: PlanShape[]
  selectedShapeId?: string | null
  /** A drawing tool in hand: presses draw instead of selecting. */
  shapeTool?: ShapeTool | null
  // ── Snapshots ─────────────────────────────────────────────────────────
  /** The Snapshot tool in hand: a drag on the plan sweeps a rectangle of
   * whole cells, reported on release. */
  onSnapshotRect?: (rect: {
    x: number
    y: number
    w: number
    h: number
  }) => void
  /** Rows shown but not editable here: on a live view, the ones crossing
   * its edge. Dimmed and inert while editing. */
  lockedIds?: ReadonlySet<string>
  /** Clip everything to the grid (a live view's objects run past it). */
  clipToGrid?: boolean
  /** Where the background image spans, in cells, when it is not the grid
   * (a live view shows its part of the source's image). */
  backgroundFrame?: {
    x: number
    y: number
    width: number
    height: number
  } | null
  onSelectShape?: (id: string | null) => void
  onChangeShape?: (id: string, patch: Partial<PlanShape>) => void
  onCreateArea?: (geom: NewAreaGeometry) => void
  onCreateLabel?: (at: { x: number; y: number }) => void
  /** Viewing: an area or label clicked. */
  onOpenShape?: (shape: PlanShape) => void
  onDeleteShape?: (id: string) => void
  /** Bring forward (+1) or send back (-1). */
  onRestackShape?: (id: string, dir: 1 | -1) => void
  // ── Placing objects ───────────────────────────────────────────────────
  /** Rows dragged from the Place picker or the unplaced list were dropped
   * at this cell point. */
  onDropRows?: (rows: FloorPlanPlaceable[], at: Pt) => void
  /** Floats above the one selected tile, area or label (Edit). */
  selectionToolbar?: React.ReactNode
  className?: string
}

type DragState =
  | { mode: "pan" }
  | { mode: "move"; id: string; grabDx: number; grabDy: number; moved: boolean }
  | {
      mode: "group"
      id: string
      start: CellPoint
      /** The offset already applied to the selection, in cells. */
      dx: number
      dy: number
      moved: boolean
    }
  | { mode: "resize"; id: string; origin: CellPoint }
  | { mode: "paint"; start: CellPoint; end: CellPoint }
  | { mode: "marquee"; start: CellPoint; end: CellPoint }
  | { mode: "snapshot"; start: CellPoint; end: CellPoint }
  | { mode: "area-move"; id: string; grabDx: number; grabDy: number }
  | { mode: "area-resize"; id: string; origin: CellPoint }
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
  | {
      mode: "wall-move"
      id: string
      grab: [number, number]
      orig: [number, number][]
      moved: boolean
    }

/**
 * The rendering core: one `<svg>` with a pan/zoom `<g>`, a cell `<pattern>`
 * grid, the background blueprint, and one `<g>` per tile. Orientation is
 * grid-honest - the rect stays axis-aligned (rotating swaps width/height at
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
  raisedFloors,
  selectedAreaId,
  onSelectArea,
  onAreaRectChange,
  walls = [],
  selectedWallId = null,
  onSelectWall,
  onMoveWall,
  doorArmed = false,
  onPlaceDoor,
  onSelect,
  multiSelectedIds,
  onToggleSelect,
  onMoveSelection,
  onGestureStart,
  onGestureEnd,
  onMarquee,
  onChangeTile,
  onCreateRect,
  onOpenTile,
  onClickTile,
  onHoverTile,
  exportRef,
  liveState,
  colorBy = "type",
  rackFigures: figures,
  highlightTileIds,
  dimTileIds,
  overlay,
  labelFit = false,
  showFov = true,
  showZoneLabels = true,
  photoOutlines = false,
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
  cablePaths = NO_CABLES,
  showCableLinks = false,
  highlightCableIds = NO_IDS,
  onSelectCable,
  onHighlightCables,
  cableRoutes = NO_ROUTES,
  cableColorBy = "status",
  showCableLabels = true,
  bundleCables = true,
  onHoverCable,
  apiRef,
  underlay,
  worldOverlay,
  onPickPoint,
  shapes = [],
  selectedShapeId = null,
  shapeTool = null,
  onSnapshotRect,
  lockedIds,
  clipToGrid = false,
  backgroundFrame = null,
  onSelectShape,
  onChangeShape,
  onCreateArea,
  onCreateLabel,
  onOpenShape,
  onDeleteShape,
  onRestackShape,
  onDropRows,
  selectionToolbar,
  className,
}: FloorCanvasProps) {
  // The cell point under the pointer while it is over the plan.
  const pointerAt = useRef<Pt | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<DragState | null>(null)
  // Point-pick mode: where the press started, to tell a click from a pan.
  const pickStart = useRef<{ x: number; y: number } | null>(null)
  const paintPreview = useRef<SVGRectElement>(null)
  // Structure mode: the area being dragged/resized, rendered over the query
  // data until release commits it (server validates overlap/bounds).
  const [areaDraft, setAreaDraft] = useState<{
    id: string
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const drawPreview = useRef<SVGPolylineElement>(null)
  // Live points of the tray being dragged/reshaped (null = none).
  const [trayDraft, setTrayDraft] = useState<{
    id: string
    points: [number, number][]
  } | null>(null)
  // Live points of the wall being moved (whole-run translate).
  const [wallDraft, setWallDraft] = useState<{
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
  const {
    t,
    setT,
    onWheel,
    startPan,
    movePan,
    endPan,
    toWorld,
    fitTo,
    pinchDown,
    pinchMove,
    pinchUp,
  } = usePanZoom()

  // The cable layer is memoised; its callbacks must hold still while the
  // canvas re-renders on every pan frame.
  const tNow = useRef(t)
  tNow.current = t
  const cableProps = useRef({ onSelectCable, onHoverCable })
  cableProps.current = { onSelectCable, onHoverCable }
  const selectCable = useCallback(
    (id: string | null) => cableProps.current.onSelectCable?.(id),
    []
  )
  const hoverCable = useCallback(
    (hit: CableHoverHit | null, at?: CableAnchor) => {
      const report = cableProps.current.onHoverCable
      if (!report) return
      const rect = svgRef.current?.getBoundingClientRect()
      if (!hit || !at || !rect) {
        report(null, null)
        return
      }
      // Not while dragging or panning: a popover chasing the pointer.
      if (drag.current) return
      const tt = tNow.current
      report(
        hit,
        "cell" in at
          ? {
              x: tt.x + at.cell[0] * CELL * tt.k,
              y: tt.y + at.cell[1] * CELL * tt.k,
            }
          : { x: at.clientX - rect.left, y: at.clientY - rect.top }
      )
    },
    []
  )

  const editing = trayEditMode
  const gw = plan.grid_width * CELL
  const gh = plan.grid_height * CELL
  // Cable mode draws trays; Structure mode draws walls - same polyline rig.
  const drawing = (mode === "cable" || mode === "structure") && !!drawPoints
  // A free plan: tiles move smoothly, turn to any angle, may overlap.
  const free = plan.layout_mode === "free"
  // Areas and labels answer the pointer in Layout mode only.
  // A palette type armed paints tiles over them.
  const snapshotting = editable && !!onSnapshotRect
  const shapesLive =
    mode === "layout" && !editing && !(editable && armed) && !snapshotting
  /** Shown, but not to be edited here (a live view's edge rows). */
  const isLocked = (id: string) => editable && !!lockedIds?.has(id)
  const shapeG = useShapeGestures({
    svgRef,
    toWorld,
    zoom: t.k,
    plan,
    shapes,
    tiles,
    tool: mode === "layout" ? shapeTool : null,
    editable,
    selectedShapeId,
    onSelectShape,
    onChangeShape,
    onCreateArea,
    onCreateLabel,
    onOpenShape,
    onChangeTile,
    onGestureStart,
    onGestureEnd,
    startPan: (e) => {
      svgRef.current?.setPointerCapture(e.pointerId)
      drag.current = { mode: "pan" }
      startPan(e)
    },
  })
  // Right-click on an area, a label or a polygon's point.
  const [shapeMenu, setShapeMenu] = useState<{
    x: number
    y: number
    id: string
    vertex?: number
  } | null>(null)
  const areas = shapes.filter((s) => s.kind === "area").sort(byZ)
  const labels = shapes.filter((s) => s.kind === "label").sort(byZ)
  const selectedShape = shapes.find((s) => s.id === selectedShapeId) ?? null
  const selectedTile =
    free && editable && mode === "layout" && selectedId
      ? (tiles.find((x) => x.id === selectedId) ?? null)
      : null

  // Fit the grid on first mount (and when the plan changes identity).
  useEffect(() => {
    fitTo(svgRef.current, gw, gh)
  }, [plan.id])

  // React attaches onWheel as a PASSIVE listener, so the zoom handler's
  // preventDefault is silently ignored and the page scrolls under the zoom -
  // invisible on the fullscreen editor, obvious on the dashboard widget. A
  // native non-passive listener actually stops the scroll; the React handler
  // still does the zoom math.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const stop = (e: WheelEvent) => e.preventDefault()
    el.addEventListener("wheel", stop, { passive: false })
    return () => el.removeEventListener("wheel", stop)
  }, [])

  // Parent-driven camera: fit the whole grid, or centre + zoom onto a tile.
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      fit: () => fitTo(svgRef.current, gw, gh),
      focusTile: (tile, zoom) => {
        const svg = svgRef.current
        if (!svg) return
        const rect = svg.getBoundingClientRect()
        const k = zoom ?? 1.4
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
  // The polygon tool's keys (Enter, Backspace, Esc) reach it through the
  // same handle; refreshed each render, as the drawing is state.
  useEffect(() => {
    if (!apiRef?.current) return
    apiRef.current.finishPolygon = shapeG.finishPolygon
    apiRef.current.popPoint = shapeG.popPoint
    apiRef.current.cancelDraw = shapeG.cancelDraw
    apiRef.current.drawingShape = () => !!shapeG.poly
    apiRef.current.centerCell = () => {
      const svg = svgRef.current
      if (!svg) return [plan.grid_width / 2, plan.grid_height / 2]
      const r = svg.getBoundingClientRect()
      const w = toWorld(svg, r.left + r.width / 2, r.top + r.height / 2)
      return [w.x / CELL, w.y / CELL]
    }
    apiRef.current.pointerCell = () => pointerAt.current
  })
  // Putting the tool down drops a drawing it left open.
  useEffect(() => {
    if (shapeTool !== "polygon") shapeG.cancelDraw()
  }, [shapeTool])

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

    // Magnetic snap: nearest vertex or on-segment point within 0.5 cell.
    // Cable mode chains into trays; Structure mode chains walls into walls.
    const snapSources: { points: [number, number][] }[] =
      mode === "structure" ? walls : trays
    let best: [number, number] | null = null
    let bestD = 0.5
    for (const tray of snapSources) {
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
    // Structure mode with a wall draw in progress: clicks drop vertices.
    if (mode === "structure" && drawing) {
      onAddDrawPoint?.(toLattice(e))
      return
    }
    // A drawing tool (area, polygon, label) draws wherever it is pressed.
    if (mode === "layout" && shapeG.drawDown(e)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (snapshotting) {
      const c = toCell(e)
      drag.current = { mode: "snapshot", start: c, end: c }
    } else if (editable && !armed && e.shiftKey && onMarquee) {
      // Shift-drag = selection sweep. Plain drag stays panning, so the
      // marquee never fights the hand tool.
      const c = toCell(e)
      drag.current = { mode: "marquee", start: c, end: c }
    } else if (editable && armed) {
      const c = toCell(e)
      drag.current = { mode: "paint", start: c, end: c }
    } else {
      drag.current = { mode: "pan" }
      startPan(e)
      onSelect?.(null)
      onSelectArea?.(null)
      onSelectWall?.(null)
      onSelectCable?.(null)
      onSelectShape?.(null)
    }
  }

  const handleTileDown = (tile: FloorPlanTile, e: React.PointerEvent) => {
    if (e.button !== 0) return
    // In cable/structure mode (or while editing a tray) tiles are inert.
    if (mode === "cable" || mode === "structure" || editing) return
    // A drawing tool draws over the tile (the press reaches the plan).
    if (editable && (shapeTool || snapshotting)) return
    // Locked here (a live view's edge row): the press pans instead.
    if (isLocked(tile.id)) return
    e.stopPropagation()
    if (!editable) {
      if (onClickTile) onClickTile(tile)
      else onOpenTile?.(tile)
      return
    }
    // Shift- or Ctrl/⌘-click builds the multi-selection instead of moving -
    // the bulk bar (facing, turn, type, delete) works the selected set.
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && onToggleSelect) {
      onToggleSelect(tile.id)
      return
    }
    // A tile of the multi-selection drags the whole selection; a press
    // that never moves is a plain click on that tile.
    if (
      !armed &&
      onMoveSelection &&
      multiSelectedIds &&
      multiSelectedIds.size > 1 &&
      multiSelectedIds.has(tile.id)
    ) {
      drag.current = {
        mode: "group",
        id: tile.id,
        start: toCell(e),
        dx: 0,
        dy: 0,
        moved: false,
      }
      onGestureStart?.()
      e.currentTarget.setPointerCapture(e.pointerId)
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
    onSelectShape?.(null)
    // A free plan drags tiles smoothly (snapping as areas do).
    if (free && !armed) {
      shapeG.tileDown(tile, e)
      return
    }
    const c = toCell(e)
    drag.current = {
      mode: "move",
      id: tile.id,
      grabDx: c.x - tile.x,
      grabDy: c.y - tile.y,
      moved: false,
    }
    onGestureStart?.()
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
    onGestureStart?.()
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  // Raw pointer position in cell units (no snapping) - for whole-tray moves.
  const toCellRaw = (e: React.PointerEvent): [number, number] => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    return [w.x / CELL, w.y / CELL]
  }

  // Grab a tray body → select it; in edit mode, arm a whole-tray move.
  const handleTrayDown = (tray: FloorPlanTray, e: React.PointerEvent) => {
    if (e.button !== 0 || isLocked(tray.id)) return
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

  // Grab a wall body → select it; in Structure mode, arm a whole-run move.
  const handleWallDown = (wall: FloorPlanWall, e: React.PointerEvent) => {
    if (e.button !== 0 || isLocked(wall.id)) return
    e.stopPropagation()
    onSelectWall?.(wall.id)
    if (!editable) return
    drag.current = {
      mode: "wall-move",
      id: wall.id,
      grab: toCellRaw(e),
      orig: wall.points.map((p) => [p[0], p[1]]),
      moved: false,
    }
  }

  // Armed door placement: project the click onto the segment → cells along it.
  const handleWallSegmentClick = (
    wall: FloorPlanWall,
    seg: number,
    e: React.PointerEvent
  ) => {
    if (!doorArmed || !onPlaceDoor) return
    e.stopPropagation()
    const [cx, cy] = toCellRaw(e)
    const [ax, ay] = wall.points[seg]
    const [bx, by] = wall.points[seg + 1]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return
    const at = Math.max(
      0,
      Math.min(len, ((cx - ax) * dx + (cy - ay) * dy) / len)
    )
    onPlaceDoor(wall.id, seg, at)
  }

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (svgRef.current) {
      const w = toWorld(svgRef.current, e.clientX, e.clientY)
      pointerAt.current = [w.x / CELL, w.y / CELL]
    }
    // Areas, labels and free tiles: their own gestures.
    if (shapeG.move(e)) return
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
    if (d.mode === "group") {
      // The selection follows the pointer by whole cells; where it can't
      // go it waits, and catches up once the pointer is somewhere it can.
      const dx = c.x - d.start.x
      const dy = c.y - d.start.y
      if (
        (dx !== d.dx || dy !== d.dy) &&
        onMoveSelection?.(dx - d.dx, dy - d.dy)
      ) {
        d.dx = dx
        d.dy = dy
        d.moved = true
      }
    } else if (d.mode === "move") {
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
    } else if (d.mode === "wall-move") {
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
      setWallDraft({ id: d.id, points: pts })
    } else if (d.mode === "area-move") {
      const a = raisedFloors?.find((x) => x.id === d.id)
      if (a) {
        setAreaDraft({
          id: a.id,
          x: Math.max(0, Math.round(c.x - d.grabDx)),
          y: Math.max(0, Math.round(c.y - d.grabDy)),
          width: a.width,
          height: a.height,
        })
      }
    } else if (d.mode === "area-resize") {
      const a = raisedFloors?.find((x) => x.id === d.id)
      if (a) {
        setAreaDraft({
          id: a.id,
          x: a.x,
          y: a.y,
          width: Math.max(1, Math.round(c.x - d.origin.x)),
          height: Math.max(1, Math.round(c.y - d.origin.y)),
        })
      }
    } else {
      d.end = c
      // Imperative preview - avoids re-rendering every tile per pointermove.
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

  const handleUp = (e?: React.PointerEvent) => {
    if (e && shapeG.up(e)) return
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.mode === "move" || d.mode === "resize") onGestureEnd?.()
    if (d.mode === "pan") {
      endPan()
    } else if (d.mode === "group") {
      onGestureEnd?.()
      // Pressed and released in place: a plain click on that tile.
      if (!d.moved) onSelect?.(d.id)
    } else if (d.mode === "paint") {
      paintPreview.current?.setAttribute("visibility", "hidden")
      onCreateRect?.(paintRect(d.start, d.end))
    } else if (d.mode === "marquee") {
      paintPreview.current?.setAttribute("visibility", "hidden")
      onMarquee?.(paintRect(d.start, d.end))
    } else if (d.mode === "snapshot") {
      paintPreview.current?.setAttribute("visibility", "hidden")
      onSnapshotRect?.(paintRect(d.start, d.end))
    } else if (d.mode === "area-move" || d.mode === "area-resize") {
      setAreaDraft((draft) => {
        if (draft && draft.id === d.id) {
          const a = raisedFloors?.find((x) => x.id === d.id)
          const changed =
            !a ||
            a.x !== draft.x ||
            a.y !== draft.y ||
            a.width !== draft.width ||
            a.height !== draft.height
          if (changed)
            onAreaRectChange?.(d.id, {
              x: draft.x,
              y: draft.y,
              width: draft.width,
              height: draft.height,
            })
        }
        return null
      })
    } else if (d.mode === "tray-move" || d.mode === "tray-vertex") {
      // Persist a drag, OR a "+"-click that inserted a bend without dragging.
      const changed = d.moved || (d.mode === "tray-vertex" && d.inserted)
      if (changed && trayDraft?.id === d.id)
        onMoveTray?.(d.id, trayDraft.points)
      setTrayDraft(null)
    } else if (d.mode === "wall-move") {
      if (d.moved && wallDraft?.id === d.id)
        onMoveWall?.(d.id, wallDraft.points)
      setWallDraft(null)
    }
  }

  // A pinch takes over from whatever one finger began: the drag stops where
  // it is, a paint or sweep is dropped rather than committed, a structure
  // drag snaps back, and an open undo step closes.
  const cancelDrag = () => {
    shapeG.cancel()
    const d = drag.current
    drag.current = null
    pickStart.current = null
    if (!d) return
    if (d.mode === "pan") endPan()
    else if (d.mode === "move" || d.mode === "resize" || d.mode === "group")
      onGestureEnd?.()
    else if (
      d.mode === "paint" ||
      d.mode === "marquee" ||
      d.mode === "snapshot"
    )
      paintPreview.current?.setAttribute("visibility", "hidden")
    setAreaDraft(null)
    setTrayDraft(null)
    setWallDraft(null)
  }

  // Right-click → a small menu; hit-test which non-zone tile is under it.
  const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const wx = (e.clientX - rect.left - t.x) / t.k / CELL
    const wy = (e.clientY - rect.top - t.y) / t.k / CELL
    // Editing: a label or an area under the pointer gets its own menu
    // (forward, back, delete) - labels first, they draw on top.
    if (editable && mode === "layout") {
      const shapeHit = [
        ...labels.slice().reverse(),
        ...areas.slice().reverse(),
      ].find((s) => {
        if (s.kind === "area" && s.shape === "polygon")
          return pointInPolygon([wx, wy], s.points)
        const b = s.kind === "label" ? labelBox(s, plan.cell_mm) : s
        return pointInBox([wx, wy], b)
      })
      if (shapeHit) {
        setShapeMenu({ x: e.clientX, y: e.clientY, id: shapeHit.id })
        onSelectShape?.(shapeHit.id)
        return
      }
    }
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
    // Suppress while dragging/panning/drawing - a popover chasing the cursor
    // mid-drag is noise.
    if (drag.current || drawing) return
    onHoverTile?.(tile, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // Cables whose A↔B run touches a tile - for "trace cables here".
  const cablesTouching = (tileId: string) =>
    cablePaths
      .filter(
        (cp) => cp.a_tiles.includes(tileId) || cp.b_tiles.includes(tileId)
      )
      .map((cp) => cp.id)

  /** One tile on the plan. */
  const renderTile = (tile: FloorPlanTile) => {
    // A free plan draws a tile turned by what its angle has beyond
    // its quarter turn (shapes.ts tileResidual).
    const residual = free ? tileBox(tile).rotation : 0
    const shown = residual
      ? { ...tile, orientation: tileQuarter(tile.orientation) }
      : tile
    return (
      // In Structure mode tiles are context, not targets - they pass
      // pointer events through so an area underneath stays reachable
      // (and movable) even when fully covered by racks.
      <g
        key={tile.id}
        pointerEvents={
          mode === "structure" || isLocked(tile.id) ? "none" : undefined
        }
        opacity={isLocked(tile.id) ? LOCKED_OPACITY : undefined}
        transform={
          residual
            ? `rotate(${residual},${(tile.x + tile.width / 2) * CELL},${(tile.y + tile.height / 2) * CELL})`
            : undefined
        }
      >
        <TileShape
          tile={shown}
          grip={!free}
          selected={tile.id === selectedId || !!multiSelectedIds?.has(tile.id)}
          editable={editable}
          labelFit={labelFit}
          showZoneLabels={showZoneLabels}
          photoOutline={photoOutlines}
          live={liveState?.tiles[tile.id]}
          colorBy={colorBy}
          figures={figures?.get(tile.id)}
          highlighted={!!highlightTileIds?.has(tile.id)}
          dimmed={!!dimTileIds?.has(tile.id)}
          onPointerDown={(e) => handleTileDown(tile, e)}
          onResizeDown={(e) => handleResizeDown(tile, e)}
          // In Cables mode a double-click finishes a tray draw - don't
          // also open the tile's deep-view underneath it.
          onDoubleClick={() => {
            if (mode !== "cable") onOpenTile?.(tile)
          }}
          onPointerEnter={(e) => reportHover(tile, e)}
          onPointerLeave={() => onHoverTile?.(null, null)}
        />
      </g>
    )
  }

  return (
    <div
      ref={exportRef}
      // Marks the canvas so overlays (the tile popover) can tell a click on the
      // plan - which their own select/pin logic already handles - from a genuine
      // click elsewhere in the app.
      data-floor-canvas=""
      className={cn(
        "relative h-full w-full overflow-hidden bg-background",
        className
      )}
      // Rows dragged from the Place picker or the unplaced list.
      onDragOver={(e) => {
        if (!onDropRows || !e.dataTransfer.types.includes(PLACE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      }}
      onDrop={(e) => {
        if (!onDropRows || !svgRef.current) return
        const raw = e.dataTransfer.getData(PLACE_MIME)
        if (!raw) return
        e.preventDefault()
        let rows: FloorPlanPlaceable[]
        try {
          rows = JSON.parse(raw)
        } catch {
          return
        }
        if (!Array.isArray(rows) || !rows.length) return
        const w = toWorld(svgRef.current, e.clientX, e.clientY)
        onDropRows(rows, [w.x / CELL, w.y / CELL])
      }}
    >
      <svg
        ref={svgRef}
        className="h-full w-full touch-none text-foreground select-none"
        onWheel={onWheel}
        onPointerDownCapture={(e) => {
          // A second finger turns the touch into a pinch: it owns the
          // press, and what the first finger started stops where it is.
          if (pinchDown(e)) {
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            setCtxMenu(null)
            cancelDrag()
            return
          }
          if (!onPickPoint) return
          // Picking owns the press: nothing under it selects, moves
          // or paints. A drag still pans the plan.
          if (e.button !== 0) return
          e.stopPropagation()
          setCtxMenu(null)
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { mode: "pan" }
          startPan(e)
          pickStart.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerDown={(e) => {
          setCtxMenu(null)
          handleBackgroundDown(e)
        }}
        onPointerMove={(e) => {
          if (pinchMove(e)) return
          handleMove(e)
        }}
        onPointerCancel={pinchUp}
        onPointerUp={(e) => {
          if (pinchUp(e)) {
            pickStart.current = null
            return
          }
          const start = pickStart.current
          pickStart.current = null
          if (
            start &&
            onPickPoint &&
            svgRef.current &&
            Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5
          )
            onPickPoint(toWorld(svgRef.current, e.clientX, e.clientY))
          handleUp(e)
        }}
        onPointerLeave={(e) => {
          pickStart.current = null
          pointerAt.current = null
          if (pinchUp(e)) return
          handleUp(e)
        }}
        onDoubleClick={() => {
          if (drawing) onFinishDraw?.()
          else if (shapeG.poly) shapeG.finishPolygon()
        }}
        onContextMenu={handleContextMenu}
        style={{
          cursor:
            (armed && editable) ||
            snapshotting ||
            drawing ||
            onPickPoint ||
            (editable && mode === "layout" && shapeTool)
              ? "crosshair"
              : "grab",
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
        {clipToGrid && (
          <defs>
            <clipPath id={`fp-grid-clip-${plan.id}`}>
              <rect width={gw} height={gh} />
            </clipPath>
          </defs>
        )}
        <g
          transform={`translate(${t.x},${t.y}) scale(${t.k})`}
          clipPath={clipToGrid ? `url(#fp-grid-clip-${plan.id})` : undefined}
        >
          {/* Floor surface */}
          <rect width={gw} height={gh} className="fill-muted/30" rx={4} />
          {plan.background_image && (
            <image
              href={plan.background_image}
              x={(backgroundFrame?.x ?? 0) * CELL}
              y={(backgroundFrame?.y ?? 0) * CELL}
              width={backgroundFrame ? backgroundFrame.width * CELL : gw}
              height={backgroundFrame ? backgroundFrame.height * CELL : gh}
              opacity={plan.background_opacity / 100}
              preserveAspectRatio="none"
            />
          )}
          {underlay}
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

          {/* Raised-floor areas - construction context under everything.
              Interactive (selectable) only in Structure mode. */}
          {(raisedFloors ?? []).map((raw) => {
            // While dragging/resizing, render the draft rect instead.
            const a =
              areaDraft && areaDraft.id === raw.id
                ? { ...raw, ...areaDraft }
                : raw
            const labelText = `${a.label || "Raised floor"} · ${a.plenum_mm} mm`
            // ~5.6 px/char at 10px - hide the label when it would spill past
            // the area's edge (the rail always shows the full name).
            const labelFits = a.width * CELL - 12 >= labelText.length * 5.6
            return (
              <g
                key={a.id}
                opacity={isLocked(a.id) ? LOCKED_OPACITY : undefined}
                onPointerDown={
                  isLocked(a.id)
                    ? undefined
                    : mode === "structure" && editable
                      ? (e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          onSelectArea?.(a.id)
                          e.currentTarget.setPointerCapture(e.pointerId)
                          const c = toCell(e)
                          drag.current = {
                            mode: "area-move",
                            id: a.id,
                            grabDx: c.x - a.x,
                            grabDy: c.y - a.y,
                          }
                        }
                      : mode === "structure"
                        ? (e) => {
                            e.stopPropagation()
                            onSelectArea?.(a.id)
                          }
                        : undefined
                }
                style={{
                  cursor:
                    mode === "structure"
                      ? editable
                        ? "move"
                        : "pointer"
                      : undefined,
                  pointerEvents:
                    mode === "structure" && !isLocked(a.id) ? "auto" : "none",
                }}
              >
                <rect
                  x={a.x * CELL}
                  y={a.y * CELL}
                  width={a.width * CELL}
                  height={a.height * CELL}
                  fill={a.color || "#71717a"}
                  fillOpacity={0.1}
                  stroke={a.color || "#71717a"}
                  strokeOpacity={a.id === selectedAreaId ? 0.9 : 0.35}
                  strokeWidth={a.id === selectedAreaId ? 2.5 : 1.5}
                  strokeDasharray="7 4"
                  rx={3}
                />
                {(a.label || a.id === selectedAreaId) && labelFits && (
                  <text
                    x={a.x * CELL + 6}
                    y={a.y * CELL + 14}
                    className="fill-muted-foreground"
                    fontSize={10}
                    pointerEvents="none"
                  >
                    {labelText}
                  </text>
                )}
                {mode === "structure" &&
                  editable &&
                  a.id === selectedAreaId && (
                    // Bottom-right resize grip, same drag pattern as tiles.
                    <rect
                      x={(a.x + a.width) * CELL - 7}
                      y={(a.y + a.height) * CELL - 7}
                      width={10}
                      height={10}
                      rx={2}
                      fill={a.color || "#71717a"}
                      style={{ cursor: "nwse-resize" }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return
                        e.stopPropagation()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        drag.current = {
                          mode: "area-resize",
                          id: a.id,
                          origin: { x: a.x, y: a.y },
                        }
                      }}
                    />
                  )}
              </g>
            )
          })}

          {/* Zones first (background), then areas (rooms), then normal
              tiles, then FOV cones. */}
          {tiles.filter(tileIsZone).map(renderTile)}
          <g data-layer="areas">
            {areas.map((a) => (
              <AreaShapeView
                key={a.id}
                area={a}
                selected={a.id === selectedShapeId}
                interactive={shapesLive && !isLocked(a.id)}
                onPointerDown={(e) => shapeG.shapeDown(a, e)}
                onEdgeDoubleClick={
                  editable && a.id === selectedShapeId
                    ? (seg, e) => shapeG.addVertex(a.id, seg, e)
                    : undefined
                }
              />
            ))}
          </g>
          {/* On a free plan tiles may overlap: their z says which is on
              top. */}
          {(free
            ? tiles
                .filter((tl) => !tileIsZone(tl))
                .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
            : tiles.filter((tl) => !tileIsZone(tl))
          ).map(renderTile)}

          {showFov &&
            tiles
              .filter(
                (tl) =>
                  tileHasFov(tl) &&
                  tl.fov_distance &&
                  (tl.fov_ptz || tl.fov_deg)
              )
              .map((tl) => <FovCone key={`fov-${tl.id}`} tile={tl} />)}

          {/* Walls - the structural print, in every mode: solid spans broken
              by door gaps with threshold ticks. Interactive (select / move /
              place doors) only in Structure mode. */}
          {walls.map((w) => (
            <WallShape
              key={w.id}
              wall={
                wallDraft?.id === w.id ? { ...w, points: wallDraft.points } : w
              }
              cellMM={plan.cell_mm}
              selected={w.id === selectedWallId}
              interactive={mode === "structure" && !drawing && !isLocked(w.id)}
              editable={
                editable && mode === "structure" && !drawing && !isLocked(w.id)
              }
              doorArmed={doorArmed}
              onPointerDown={(e) => handleWallDown(w, e)}
              onSegmentClick={(seg, e) => handleWallSegmentClick(w, seg, e)}
            />
          ))}

          {/* Cable trays - drawn above tiles so the run reads on a builder's
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
                  interactive={
                    mode === "cable" && !drawing && !isLocked(tray.id)
                  }
                  editable={
                    editable &&
                    mode === "cable" &&
                    !drawing &&
                    trayEditMode &&
                    !isLocked(tray.id)
                  }
                  editing={isEditing}
                  dimmed={isLocked(tray.id)}
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

          {/* Cable A↔B runs (cable-layer.tsx): in lanes along their trays,
              orthogonal elbows between tiles, bundled where lanes would not
              read. Clickable in any mode when the links overlay is on - no
              Cables mode needed. Edit trays hides them so trays are free to
              grab. */}
          {showCableLinks && !trayEditMode && (
            <CableLayer
              cablePaths={cablePaths}
              routes={cableRoutes}
              k={t.k}
              cellMm={plan.cell_mm}
              colorBy={cableColorBy}
              bundle={bundleCables}
              showLabels={showCableLabels}
              highlightIds={highlightCableIds}
              interactive
              onSelect={selectCable}
              onHover={hoverCable}
            />
          )}

          {/* Labels - over the tiles, so "North side" reads over a row. */}
          <g data-layer="labels">
            {labels.map((l) => (
              <LabelShapeView
                key={l.id}
                label={l}
                cellMm={plan.cell_mm}
                interactive={shapesLive && editable && !isLocked(l.id)}
                onPointerDown={(e) => shapeG.shapeDown(l, e)}
              />
            ))}
          </g>

          {/* The selection's handles: a box (area, label, free tile) turns
              and resizes; a polygon drags its points. */}
          {editable &&
            mode === "layout" &&
            !shapeTool &&
            selectedShape &&
            !selectedShape.locked &&
            (selectedShape.kind === "area" &&
            selectedShape.shape === "polygon" ? (
              <VertexHandles
                area={selectedShape}
                zoom={t.k}
                gestures={shapeG}
                onVertexMenu={(index, e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setShapeMenu({
                    x: e.clientX,
                    y: e.clientY,
                    id: selectedShape.id,
                    vertex: index,
                  })
                }}
              />
            ) : (
              <BoxHandles
                box={
                  selectedShape.kind === "label"
                    ? labelBox(selectedShape, plan.cell_mm)
                    : selectedShape
                }
                target={{ kind: "shape", id: selectedShape.id }}
                zoom={t.k}
                gestures={shapeG}
                // A label's box follows its text: its corners scale it.
                handles={
                  selectedShape.kind === "label"
                    ? ["nw", "ne", "se", "sw"]
                    : undefined
                }
              />
            ))}
          {selectedTile && !multiSelectedIds?.size && (
            <BoxHandles
              box={tileBox(selectedTile)}
              target={{ kind: "tile", id: selectedTile.id }}
              zoom={t.k}
              gestures={shapeG}
              // A photo resizes from its corners, keeping its proportions.
              handles={
                selectedTile.display === "photo" && selectedTile.photo
                  ? ["nw", "ne", "se", "sw"]
                  : undefined
              }
            />
          )}
          <DrawPreview gestures={shapeG} width={gw} height={gh} zoom={t.k} />

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
          {worldOverlay}
        </g>
      </svg>

      {overlay}

      {/* The floating toolbar, just above the selection. */}
      {(() => {
        if (!selectionToolbar || !editable || mode !== "layout" || shapeTool)
          return null
        let b: ReturnType<typeof boxBounds> | null = null
        if (selectedShape) b = shapeBounds(selectedShape, plan.cell_mm)
        else if (selectedId && !multiSelectedIds?.size) {
          const tl = tiles.find((x) => x.id === selectedId)
          if (tl) b = boxBounds(tileBox(tl))
        }
        if (!b) return null
        return (
          <div
            data-part="selection-toolbar"
            className="pointer-events-auto absolute z-20 -translate-x-1/2 -translate-y-full"
            style={{
              left: ((b.minX + b.maxX) / 2) * CELL * t.k + t.x,
              top: Math.max(40, b.minY * CELL * t.k + t.y - 10),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {selectionToolbar}
          </div>
        )
      })()}

      {/* An area's or label's menu, and a polygon point's. */}
      <PointerMenu
        menu={shapeMenu}
        onClose={() => setShapeMenu(null)}
        label="Shape"
        keys={(m) => ({ Delete: () => onDeleteShape?.(m.id) })}
      >
        {(m) => {
          const s = shapes.find((x) => x.id === m.id)
          if (!s) return null
          if (m.vertex !== undefined && s.kind === "area")
            return (
              <DropdownMenuItem
                disabled={s.points.length <= 3}
                onSelect={() =>
                  onChangeShape?.(
                    s.id,
                    polygonPatch(s.points.filter((_, i) => i !== m.vertex))
                  )
                }
              >
                Remove point
              </DropdownMenuItem>
            )
          return (
            <>
              <DropdownMenuItem onSelect={() => onRestackShape?.(s.id, 1)}>
                Bring forward
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRestackShape?.(s.id, -1)}>
                Send back
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onChangeShape?.(s.id, { locked: !s.locked })}
              >
                {s.locked ? "Unlock" : "Lock"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDeleteShape?.(s.id)}
              >
                Delete
              </DropdownMenuItem>
            </>
          )
        }}
      </PointerMenu>

      {/* Right-click menu - a small, extensible action list.
          The trigger is a zero-size anchor parked at the pointer (the same trick
          the tile popover's anchor uses) and the menu itself is the shared
          DropdownMenu, so it portals out of this wrapper and flips on collision.
          Hand-rolled, it was an absolute div inside `overflow-hidden` and got
          cut off - unreachably - on a right-click near the canvas edge.
          Non-modal: a click on the plan must still pan/select while dismissing,
          and the wheel must keep zooming. Keyed by position so a second
          right-click re-anchors even if the first menu never closed. */}
      {ctxMenu && (
        <DropdownMenu
          key={`${ctxMenu.x},${ctxMenu.y}`}
          open
          onOpenChange={(open) => {
            if (!open) setCtxMenu(null)
          }}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <div
              aria-hidden
              className="pointer-events-none absolute"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={0}
            className="w-auto min-w-40"
          >
            {ctxMenu.vertex && (
              <DropdownMenuItem
                onSelect={() => {
                  removeVertex(ctxMenu.vertex!.trayId, ctxMenu.vertex!.index)
                  setCtxMenu(null)
                }}
              >
                Remove bend
              </DropdownMenuItem>
            )}
            {ctxMenu.tile && (
              <>
                <DropdownMenuLabel className="truncate">
                  {tileName(ctxMenu.tile) ||
                    ctxMenu.tile.tile_type?.name ||
                    ctxMenu.tile.role_type?.name ||
                    "Tile"}
                </DropdownMenuLabel>
                {onHighlightCables &&
                  cablesTouching(ctxMenu.tile.id).length > 0 && (
                    <DropdownMenuItem
                      onSelect={() => {
                        onHighlightCables(cablesTouching(ctxMenu.tile!.id))
                        setCtxMenu(null)
                      }}
                    >
                      Trace cables here
                    </DropdownMenuItem>
                  )}
                {ctxMenu.tile.linked && onOpenTile && (
                  <DropdownMenuItem
                    onSelect={() => {
                      onOpenTile(ctxMenu.tile!)
                      setCtxMenu(null)
                    }}
                  >
                    Open{" "}
                    {ctxMenu.tile.linked.kind === "floorplan"
                      ? "plan"
                      : ctxMenu.tile.linked.kind}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onSelect={() => {
                fitTo(svgRef.current, gw, gh)
                setCtxMenu(null)
              }}
            >
              Fit to view
            </DropdownMenuItem>
            {highlightCableIds.length > 0 && (
              <DropdownMenuItem
                onSelect={() => {
                  onSelectCable?.(null)
                  setCtxMenu(null)
                }}
              >
                Clear trace
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
