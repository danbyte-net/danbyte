import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorPlanPlaceable,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
  RaisedFloorArea,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useTheme } from "@/components/theme-provider"

import type { Pt } from "./cable-route"
import { CELL, tileHasFov, tileIsZone, tileName } from "./canvas-geometry"
import type { CellPoint, PaletteEntry } from "./canvas-geometry"
import {
  ClusterTile,
  FovCone,
  IconLeader,
  ReadableSymbol,
  TileMarkers,
  TileShape,
  createHoverStore,
} from "./tile-layer"
import {
  CLUSTER_SIDE,
  EMPTY_ICON_LAYOUT,
  clusterFace,
  clusterFitView,
  drawnCentre,
  keepBoxOf,
  layoutIcons,
  pullOut,
  scaleBox,
  squareAt,
  zoomBucket,
} from "./icon-layout"
import { AreaMask } from "./area-mask"
import type { ClusterFace, IconCluster, IconLayout } from "./icon-layout"
import {
  ICON_TILE_EXIT_PX,
  READABLE_FONT_PX,
  READABLE_SYMBOL_PX,
  fontGrow,
  growStubs,
  iconTileIds,
  iconTileShape,
  readableHit,
  readableOrder,
  readableShape,
  splitGrown,
} from "./readable"
import { MuteFilter, muteFilterId, mutesBasemap } from "./background-look"
import { OnionLayer } from "./onion-layer"
import type { OnionSkin } from "./onion-layer"
import { PlanLabelsLayer, useSettled } from "./plan-labels-layer"
import { layoutPlanLabels } from "./plan-label-pass"
import { PlanCalloutsLayer } from "./plan-callouts-layer"
import type { CalloutLine } from "./plan-callouts"
import { LABEL_FONT_PX, LABEL_REPEAT_PX, CHIP_FONT_PX } from "./plan-labels"
import {
  LANE_MIN_PX,
  bundledGroups,
  cableLod,
  laneOrder,
  layoutCables,
} from "./cable-draw"
import type { CalloutMode, ObjectSize, ShapeOf } from "./readable"
import { tileFill } from "./tile-paint"
import type { ColorBy, RackFigures } from "./tile-paint"
import {
  AreaShapeView,
  BoxHandles,
  HANDLE_PX,
  DrawPreview,
  LabelShapeView,
  VertexHandles,
} from "./shape-layer"
import { PLACE_MIME, fitToSizeRect } from "./placement"
import {
  boxBounds,
  byZ,
  labelBox,
  opensLink as opensLabel,
  opensName,
  pointInBox,
  pointInPolygon,
  polygonPatch,
  shapeBounds,
  tileBox,
  tileQuarter,
} from "./shapes"
import type { LabelShape, PlanShape } from "./shapes"
import { snapshotAreaLabel } from "./snapshot"
import { TrayShape } from "./tray-layer"
import { CableLayer } from "./cable-layer"
import type { CableAnchor, CableHoverHit, CablePickAt } from "./cable-layer"
import { CableChooser } from "./cable-chooser"
import type { CableChooserAt } from "./cable-chooser"
import type { CableColorBy, CableRoute, CableStub } from "./cable-draw"
import { usePanZoom } from "./use-pan-zoom"
import { useShapeGestures } from "./use-shape-gestures"
import type { ShapeTool } from "./use-shape-gestures"
import type { NewAreaGeometry } from "./use-shape-edits"
import { WallShape, wallStrokePx } from "./wall-layer"
import {
  DoorHandles,
  RectHandles,
  RunHandles,
  StructureOverlay,
} from "./structure-handles"
import {
  nearestSegment,
  pointsBoundsOf,
  runsTouch,
  structureLists,
} from "./structure"
import type { RunRow, StructShape } from "./structure"
import { useStructureGestures } from "./use-structure-gestures"

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
const NO_ICONS: ReadonlySet<string> = new Set()
const NO_ROUTES: ReadonlyMap<string, CableRoute> = new Map()
const NO_STRUCT: StructShape[] = []

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
  /** A tray's cables in the cable chooser, opened at a client point (a
   * panel's Show cables). */
  showTrayCables?: (trayId: string, at: CablePickAt) => void
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
  /** Readable: placed objects keep a least size on screen from afar, with
   * their names at a constant size (readable.ts). */
  objectSize?: ObjectSize
  /** Display > Icons when zoomed out: a device, rack or cabinet too small
   * on screen draws as its icon tile (readable.ts). */
  iconTiles?: boolean
  /** Display > Callouts: Auto names a tile whose name will not sit
   * cleanly by it in a box off to the side, a leader back to it
   * (plan-callouts.ts); Off leaves such a name hidden. */
  callouts?: CalloutMode
  /** The lines under each tile's callout name (its panel layout's callout
   * fields), by tile id. */
  calloutLines?: ReadonlyMap<string, readonly CalloutLine[]>
  /** Display > Muted background: the background image greyed and pushed
   * toward the page (background-look.tsx), so the plan reads over it. */
  muteBackground?: boolean
  // ── Raised floors and walls (Structure mode) ───────────────────────────
  /** Raised-floor rectangles, drawn UNDER every tile in all modes. */
  raisedFloors?: RaisedFloorArea[]
  /** Another level of an aligned floor plan, drawn faintly under this one. */
  onion?: OnionSkin | null
  selectedAreaId?: string | null
  /** Structure mode: a raised floor was clicked. */
  onSelectArea?: (id: string | null) => void
  /** Wall polylines with door openings - drawn in ALL modes; interactive
   * (select, drag, doors) only in Structure mode. */
  walls?: FloorPlanWall[]
  selectedWallId?: string | null
  onSelectWall?: (id: string | null) => void
  /** The Door tool (or "Add door"): a press on a wall draws a door. */
  doorArmed?: boolean
  /** The walls, trays and raised floors of the draft - what the pointer
   * edits; a tray not among them (a kept run) is drawn only. */
  structure?: StructShape[]
  /** A drag of structure dropped: rows changed (one removed after a
   * join) - one undo step. */
  onCommitStructure?: (c: { update: StructShape[]; remove?: string[] }) => void
  /** A door drawn along segment `seg` of a wall, `t0` to `t1` cells. */
  onAddDoor?: (wallId: string, seg: number, t0: number, t1: number) => void
  selectedDoor?: { wallId: string; index: number } | null
  onSelectDoor?: (door: { wallId: string; index: number } | null) => void
  /** Walls or trays picked with Shift or Ctrl/⌘ (two that touch join). */
  structSel?: ReadonlySet<string>
  onToggleStruct?: (id: string) => void
  /** What the right-click menu offers on a wall, door, tray or raised
   * floor, and "Add walls around" on areas. */
  structureActions?: StructureActions
  /** Floats above the selected wall, door, tray or raised floor (Edit). */
  structureToolbar?: React.ReactNode
  /** Areas picked with Ctrl/⌘ - walls go round all of them at once. */
  areaSel?: ReadonlySet<string>
  onToggleArea?: (id: string) => void
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
  /** Tray edit mode: hide all cables and make every tray reshapeable (drag
   * points, add/remove bends). A toggle, not per-tray. */
  trayEditMode?: boolean
  /** Picking a cable's trays ("After placing" → Pick trays): a click on a
   * tray, in any mode, adds or takes it away; the picked ones show
   * selected. */
  trayPick?: { picked: readonly string[]; onPick: (id: string) => void }
  /** Picking objects to connect to (Connect to…): a click on a tile, in
   * any mode, picks it or takes it back; the picked ones show outlined. */
  tilePick?: {
    picked: ReadonlySet<string>
    onPick: (tile: FloorPlanTile) => void
  }
  /** "Connect to…" on a placed device's, rack's or cabinet's menu. */
  onConnectTile?: (tile: FloorPlanTile) => void
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
  /** Routes computed but not saved (Document routes), drawn dotted. */
  cablePreviews?: ReadonlyMap<string, CableRoute>
  /** Cables with one end on this plan, drawn as stubs. */
  cableStubs?: readonly CableStub[]
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
  /** Point-pick mode (drawing calibration, Detect outline): a click
   * anywhere reports its world px point (and whether Shift was held)
   * instead of selecting or painting; a drag still pans. A press on an
   * element marked `data-outline-handle` is left to it. */
  onPickPoint?: (
    pt: { x: number; y: number },
    mods: { shiftKey: boolean }
  ) => void
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
  /** "Snapshot this room…" on an area's menu: open the Snapshot dialog
   * for it. */
  onSnapshotShape?: (id: string) => void
  /** Rows shown but not editable here: on a live view, the ones crossing
   * its edge. Dimmed and inert while editing. */
  lockedIds?: ReadonlySet<string>
  /** Clip everything to the grid (a live view's objects run past it).
   * The screen-size overlays - grown symbols, icon tiles, their names -
   * are never clipped. */
  clipToGrid?: boolean
  /** A live view's room (cells): everything outside it dimmed. The
   * screen-size overlays draw over the dimming and keep inside it where
   * they can. */
  maskOutline?: [number, number][] | null
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
  /** The right-click menu on empty plan space: in Edit, place, draw and
   * label at the point; in View, "Edit here" for those who may edit. */
  emptyActions?: EmptyActions
  className?: string
}

/** What the right-click menu offers on structure, at the point pressed. */
export interface StructureActions {
  addDoorAt?: (wallId: string, seg: number, t: number) => void
  addBendAt?: (id: string, seg: number, t: number) => void
  splitAt?: (id: string, seg: number, t: number) => void
  join?: (aId: string, bId: string) => void
  flipDoor?: (wallId: string, index: number) => void
  deleteDoor?: (wallId: string, index: number) => void
  deleteRow?: (id: string) => void
  removePoint?: (id: string, index: number) => void
  /** Walls round these areas. */
  wallsAround?: (areaIds: string[]) => void
}

/** What a right-click on structure hit. */
type StructMenu = {
  x: number
  y: number
  id: string
  part: StructShape["part"]
  seg?: number
  t?: number
  door?: number
  /** A point of the run, right-clicked on its handle. */
  vertex?: number
}

/** What a right-click on empty plan space offers, at its cell point. */
export interface EmptyActions {
  placeAt?: (at: Pt) => void
  drawAreaAt?: (at: Pt) => void
  /** Detect outline at the point. */
  detectAt?: (at: Pt) => void
  addLabelAt?: (at: Pt) => void
  /** Paste what was copied, when anything was. */
  pasteAt?: (at: Pt) => void
  editHere?: (at: Pt) => void
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

const sameView = (
  a: { k: number; x: number; y: number; w: number; h: number },
  b: { k: number; x: number; y: number; w: number; h: number }
) => a.k === b.k && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** An element's size on screen (px), kept up to date by a ResizeObserver;
 * 0 by 0 until measured. */
function useElementSize(ref: React.RefObject<Element | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize((s) =>
        s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
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
  walls = [],
  selectedWallId = null,
  onSelectWall,
  doorArmed = false,
  structure = NO_STRUCT,
  onCommitStructure,
  onAddDoor,
  selectedDoor = null,
  onSelectDoor,
  structSel,
  onToggleStruct,
  structureActions,
  structureToolbar,
  areaSel,
  onToggleArea,
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
  objectSize = "real",
  iconTiles = true,
  callouts = "off",
  calloutLines,
  muteBackground = false,
  onion = null,
  mode = "layout",
  trays = [],
  showTrays = true,
  selectedTrayId = null,
  onSelectTray,
  drawPoints,
  onAddDrawPoint,
  onFinishDraw,
  trayEditMode = false,
  trayPick,
  tilePick,
  onConnectTile,
  cablePaths = NO_CABLES,
  showCableLinks = false,
  highlightCableIds = NO_IDS,
  onSelectCable,
  onHighlightCables,
  cableRoutes = NO_ROUTES,
  cablePreviews,
  cableStubs,
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
  onSnapshotShape,
  lockedIds,
  clipToGrid = false,
  maskOutline = null,
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
  emptyActions,
  className,
}: FloorCanvasProps) {
  // The cell point under the pointer while it is over the plan.
  const pointerAt = useRef<Pt | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<DragState | null>(null)
  // Point-pick mode: where the press started, to tell a click from a pan.
  const pickStart = useRef<{ x: number; y: number } | null>(null)
  const paintPreview = useRef<SVGRectElement>(null)
  const drawPreview = useRef<SVGPolylineElement>(null)
  // A hint beside the handle under the pointer: what dragging it does.
  const [hint, setHint] = useState<{
    text: string
    x: number
    y: number
  } | null>(null)
  // A right-click on a wall, door, tray or raised floor.
  const [structMenu, setStructMenu] = useState<StructMenu | null>(null)
  // Which cable? A bundle's, a cluster's or a tray's (cable-chooser.tsx),
  // and the row under the pointer, drawn alone on the plan.
  const [chooser, setChooser] = useState<CableChooserAt | null>(null)
  const [chooserSolo, setChooserSolo] = useState<string | null>(null)
  // View: a tray pressed - a click on it (no drag) lists its cables.
  const trayClick = useRef<{ id: string; x: number; y: number } | null>(null)
  // View: a tray right-clicked - its menu (Show cables).
  const [trayMenu, setTrayMenu] = useState<
    (CablePickAt & { id: string }) | null
  >(null)
  // Right-click menu: screen-relative position + what's under the cursor.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    tile: FloorPlanTile | null
    /** The cell point right-clicked. */
    at?: Pt
  } | null>(null)
  // View: the name of the plan the area or label under the pointer opens.
  const [opensHint, setOpensHint] = useState<{
    id: string
    x: number
    y: number
    text: string
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

  // Readable (Display > Object size): what grows from afar, and the names
  // under it - the hovered tile's in a store of its own, so a hover
  // re-renders the names and not the canvas.
  const readable = objectSize === "readable"
  const { theme } = useTheme()
  const muteId = muteFilterId(plan.id)
  // The base map, when this floor draws it, and whether the floor layer
  // (picture or CAD drawing) is shown.
  const mapImage = (plan.map_visible && plan.base_map?.image) || null
  // Satellite imagery keeps its colours: only the street map is muted.
  const muteMap = muteBackground && mutesBasemap(plan.base_map?.basemap)
  const floorShown = plan.background_shown !== false
  const pxPerCell = CELL * t.k
  const [hoverStore] = useState(createHoverStore)
  const hoveredTile = useSyncExternalStore(
    hoverStore.subscribe,
    hoverStore.get,
    hoverStore.get
  )
  const viewSize = useElementSize(svgRef)
  // Icons when zoomed out: the tiles drawn as their icon, with hysteresis -
  // the set from the last render decides which threshold each tile meets
  // (stored during render, the documented previous-render pattern).
  const [iconPrev, setIconPrev] = useState<ReadonlySet<string>>(NO_ICONS)
  const iconIds = useMemo(
    () => (iconTiles ? iconTileIds(tiles, pxPerCell, iconPrev) : NO_ICONS),
    [iconTiles, tiles, pxPerCell, iconPrev]
  )
  if (iconIds !== iconPrev) setIconPrev(iconIds)
  const pinnedNames = useMemo(() => {
    const s = new Set(multiSelectedIds ?? [])
    if (selectedId) s.add(selectedId)
    return s
  }, [multiSelectedIds, selectedId])
  // The tile whose callout is hovered: lit on the plan with it.
  const [calloutHot, setCalloutHot] = useState<string | null>(null)
  // Settled: the view once a pan or zoom stops - the label pass and the
  // icons' layout run on it, not on every frame.
  const settledView = useSettled(
    { k: t.k, x: t.x, y: t.y, w: viewSize.w, h: viewSize.h },
    120,
    sameView
  )
  // Icons that would overlap spread apart, or fold into clusters where
  // there is no room (icon-layout.ts) - laid out for the settled zoom's
  // bucket, so a pan never moves them; the last layout holds clusters a
  // little longer (hysteresis). The selection never joins a cluster.
  const layoutK = zoomBucket(settledView.k)
  // Where the overlays keep (cells): the room of a live view, else the
  // grid - inside first, past the edge only when nothing fits.
  const keepBox = useMemo(
    () => keepBoxOf(plan.grid_width, plan.grid_height, maskOutline),
    [plan.grid_width, plan.grid_height, maskOutline]
  )
  const lastIconLayout = useRef<IconLayout>(EMPTY_ICON_LAYOUT)
  const baseIconLayout = useMemo(() => {
    if (iconIds.size < 1) return EMPTY_ICON_LAYOUT
    const items = tiles
      .filter((tl) => iconIds.has(tl.id))
      .map((tl) => ({
        id: tl.id,
        c: [tl.x + tl.width / 2, tl.y + tl.height / 2] as Pt,
      }))
    const scale = CELL * layoutK
    return layoutIcons(
      items,
      scale,
      {
        side: READABLE_SYMBOL_PX,
        prev: lastIconLayout.current,
        bounds: scaleBox(keepBox, scale),
      },
      pinnedNames
    )
  }, [iconIds, tiles, layoutK, pinnedNames, keepBox])
  useEffect(() => {
    lastIconLayout.current = baseIconLayout
  }, [baseIconLayout])
  // The tile the camera was last sent to (a search pick, a panel's Show
  // on plan, ?tile=): drawn on its own until the next.
  const [focusedTile, setFocusedTile] = useState<string | null>(null)
  // Hovered, found, or pointed at from outside (the rack table, a pick):
  // out of its cluster, on its own.
  const iconLayout = useMemo(() => {
    const out = new Set<string>(highlightTileIds ?? [])
    if (hoveredTile) out.add(hoveredTile)
    if (focusedTile) out.add(focusedTile)
    for (const id of tilePick?.picked ?? []) out.add(id)
    return pullOut(baseIconLayout, out)
  }, [
    baseIconLayout,
    highlightTileIds,
    hoveredTile,
    focusedTile,
    tilePick?.picked,
  ])
  const tileById = useMemo(
    () => new Map(tiles.map((tl) => [tl.id, tl])),
    [tiles]
  )
  const clusterFaces = useMemo(() => {
    const m = new Map<string, ClusterFace>()
    for (const c of iconLayout.clusters)
      m.set(
        c.id,
        clusterFace(
          c.members.map((id) => tileById.get(id)!).filter(Boolean),
          (tl) => liveState?.tiles[tl.id]?.check
        )
      )
    return m
  }, [iconLayout, tileById, liveState])
  /** A cluster's drawn box (cells) at `perCell` px per cell. */
  const clusterBox = useCallback(
    (c: IconCluster, perCell: number) =>
      squareAt(
        drawnCentre(iconLayout, c.id, c.anchor, perCell),
        READABLE_SYMBOL_PX * CLUSTER_SIDE,
        perCell
      ),
    [iconLayout]
  )
  /** How a tile draws when not as itself: its icon tile - spread, or
   * its cluster's box - else Readable's shape; null draws every tile at
   * its real size. */
  const shapeAt = useCallback(
    (perCell: number): ShapeOf | null =>
      !readable && iconIds.size === 0
        ? null
        : (tl) => {
            if (!iconIds.has(tl.id))
              return readable ? readableShape(tl, perCell) : null
            const c = iconLayout.clusterOf.get(tl.id)
            const box = c
              ? clusterBox(c, perCell)
              : squareAt(
                  drawnCentre(
                    iconLayout,
                    tl.id,
                    [tl.x + tl.width / 2, tl.y + tl.height / 2],
                    perCell
                  ),
                  READABLE_SYMBOL_PX,
                  perCell
                )
            return {
              box,
              grow: box.w / Math.max(tl.width, tl.height),
              changed: true,
              symbol: true,
            }
          },
    [readable, iconIds, iconLayout, clusterBox]
  )
  const shapeOf = useMemo(() => shapeAt(pxPerCell), [shapeAt, pxPerCell])
  const shownStubs = useMemo(
    () =>
      shapeOf && cableStubs
        ? growStubs(cableStubs, tiles, pxPerCell, undefined, undefined, shapeOf)
        : cableStubs,
    [shapeOf, cableStubs, tiles, pxPerCell]
  )
  // Mid-zoom the icons follow the view as it is; once settled a new
  // layout eases them to their new places.
  const iconsSettled = t.k === settledView.k
  // Hovering a cluster lists its members.
  const [clusterHint, setClusterHint] = useState<{
    id: string
    x: number
    y: number
  } | null>(null)

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
  /** Several cables under one click: ask which (the chooser), no hover
   * popover over it. */
  const chooseCables = useCallback(
    (ids: string[], at: CablePickAt, title?: string, ordered?: boolean) => {
      cableProps.current.onHoverCable?.(null, null)
      setChooserSolo(null)
      setChooser({ x: at.x, y: at.y, ids, title, ordered })
    },
    []
  )
  /** The cables under a click on the plan, nearest first (cable-pick.ts). */
  const choosePicked = useCallback(
    (ids: string[], at: CablePickAt) => chooseCables(ids, at, undefined, true),
    [chooseCables]
  )
  /** A client point on the plan, in cells - for the cable layer's pick. */
  const clientToCell = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    const tt = tNow.current
    return [
      (clientX - rect.left - tt.x) / tt.k / CELL,
      (clientY - rect.top - tt.y) / tt.k / CELL,
    ] as Pt
  }, [])
  // The hovered run's ids, for the label pass: its name and its ends.
  const [hoveredCables, setHoveredCables] = useState<readonly string[]>(NO_IDS)
  const hoverCable = useCallback(
    (hit: CableHoverHit | null, at?: CableAnchor) => {
      setHoveredCables(hit && !hit.bundle ? hit.ids : NO_IDS)
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
  const structG = useStructureGestures({
    svgRef,
    toWorld,
    zoom: t.k,
    plan,
    structure,
    editable,
    onCommit: onCommitStructure,
    onAddDoor,
    onSelectDoor,
  })
  const shownRow = <R extends { id: string }>(r: R): R =>
    (structG.preview.rows.get(r.id) as R | undefined) ?? r
  const structRow = (id: string) => {
    const r = structure.find((x) => x.id === id)
    return r ? shownRow(r) : undefined
  }
  const showHint = (text: string | null, e?: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!text || !e || !rect || structG.active() || drag.current) {
      setHint(null)
      return
    }
    setHint({ text, x: e.clientX - rect.left, y: e.clientY - rect.top - 10 })
  }
  const structLive = editable && !drawing
  // Right-click on an area, a label or a polygon's point.
  const [shapeMenu, setShapeMenu] = useState<{
    x: number
    y: number
    id: string
    vertex?: number
  } | null>(null)
  const areas = shapes.filter((s) => s.kind === "area").sort(byZ)
  const labels = shapes.filter((s) => s.kind === "label").sort(byZ)
  // The label pass, run when a pan or zoom settles: everything the plan
  // writes, in view, the cables first (plan-label-pass.ts).
  const labelLayout = useMemo(
    () => layoutCables(cableRoutes, laneOrder(cablePaths, cableRoutes)),
    [cableRoutes, cablePaths]
  )
  const cableFocus = useMemo(
    () => new Set([...highlightCableIds, ...hoveredCables]),
    [highlightCableIds, hoveredCables]
  )
  const cablesShown = showCableLinks && !trayEditMode
  const planLabels = useMemo(() => {
    const k = settledView.k
    const scale = CELL * k
    const lod = cableLod(scale)
    return layoutPlanLabels({
      scale,
      unitsPerPx: k,
      font: LABEL_FONT_PX,
      chipFont: CHIP_FONT_PX,
      repeat: LABEL_REPEAT_PX,
      gap: 4,
      view:
        settledView.w > 0
          ? {
              x: -settledView.x,
              y: -settledView.y,
              w: settledView.w,
              h: settledView.h,
            }
          : null,
      bounds: scaleBox(keepBox, scale),
      clip: scaleBox(
        { x: 0, y: 0, w: plan.grid_width, h: plan.grid_height },
        scale
      ),
      tiles,
      shapeOf: shapeAt(scale),
      iconIds,
      iconClusters: iconLayout.clusters.map((c) => ({
        id: c.id,
        box: clusterBox(c, scale),
        name: clusterFaces.get(c.id)?.name ?? "",
        members: c.members,
      })),
      labelFit,
      zoneGrow: readable ? fontGrow(10, k) : 1,
      pinnedTiles: hoveredTile
        ? new Set([...pinnedNames, hoveredTile])
        : pinnedNames,
      trays: showTrays ? trays : [],
      trayWidth: Math.max(10 * k, readable ? 6 : 4),
      areas,
      areaFontPx: 12 * (readable ? fontGrow(12, k) : 1),
      raised: (raisedFloors ?? []).map((a) => ({
        id: a.id,
        box: { x: a.x, y: a.y, w: a.width, h: a.height },
        text: `${a.label || "Raised floor"} · ${a.plenum_mm} mm`,
        fontPx: 10 * (readable ? fontGrow(10, k) : 1),
      })),
      planLabels: labels,
      cellMm: plan.cell_mm,
      callouts: callouts === "auto" ? { lines: calloutLines } : null,
      cables: cablesShown
        ? {
            paths: cablePaths,
            routes: cableRoutes,
            layout: labelLayout,
            bundled: bundledGroups(labelLayout, {
              lod,
              bundle: bundleCables,
              minGapCells: LANE_MIN_PX / scale,
            }),
            // While some are traced the rest dim: only the traced named.
            names: showCableLabels && highlightCableIds.length === 0,
            focus: cableFocus,
            focusOnly: lod === "far",
            lengths: lod === "near",
            ends: lod !== "far",
          }
        : undefined,
    })
  }, [
    settledView,
    keepBox,
    plan.grid_width,
    plan.grid_height,
    tiles,
    readable,
    shapeAt,
    iconIds,
    iconLayout,
    clusterBox,
    clusterFaces,
    labelFit,
    pinnedNames,
    hoveredTile,
    showTrays,
    trays,
    shapes,
    raisedFloors,
    plan.cell_mm,
    cablesShown,
    cablePaths,
    cableRoutes,
    labelLayout,
    bundleCables,
    showCableLabels,
    cableFocus,
    callouts,
    calloutLines,
  ])
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
        setFocusedTile(tile.id)
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
  /** A tray's cables drawn on this plan (the reader's; hidden ones are
   * only counted). */
  const trayCableIds = (tray: FloorPlanTray) => {
    const drawn = new Set(cablePaths.map((cp) => cp.id))
    return tray.cables.map((c) => c.id).filter((id) => drawn.has(id))
  }
  /** Show cables: one opens at once, several ask which. */
  const showTrayCables = (trayId: string, at: CablePickAt) => {
    const tray = trays.find((tr) => tr.id === trayId)
    if (!tray) return
    const ids = trayCableIds(tray)
    if (ids.length === 1) selectCable(ids[0])
    else if (ids.length > 1) chooseCables(ids, at, tray.name || "Tray")
  }
  /** View: a tray click lists its cables - not while picking trays for a
   * route, nor while editing, where a click selects or drags it. */
  const trayChooses = !editable && !trayPick && showCableLinks

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
    apiRef.current.showTrayCables = showTrayCables
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
      onSelectDoor?.(null)
      onSelectCable?.(null)
      onSelectShape?.(null)
    }
  }

  /** A press on a tile's callout: what a click on the tile does, but a
   * drag - the callout never moves its tile. */
  const pressCallout = (id: string, e: React.PointerEvent) => {
    const tile = tileById.get(id)
    if (!tile) return
    if (tilePick) {
      tilePick.onPick(tile)
      return
    }
    if (mode === "cable" || mode === "structure" || editing) return
    if (!editable) {
      if (onClickTile) onClickTile(tile)
      else onOpenTile?.(tile)
      return
    }
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && onToggleSelect) {
      onToggleSelect(tile.id)
      return
    }
    onSelect?.(tile.id)
    onSelectShape?.(null)
  }

  const handleTileDown = (tile: FloorPlanTile, e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (tilePick) {
      e.stopPropagation()
      tilePick.onPick(tile)
      return
    }
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

  // Grab a tray body → select it (Shift or Ctrl/⌘: pick it to join) and
  // drag it whole.
  const handleTrayDown = (tray: FloorPlanTray, e: React.PointerEvent) => {
    if (trayChooses) {
      // Not stopped: a drag from a tray still pans the plan; the release
      // in place opens its cables (the svg's pointerup).
      if (e.button === 0)
        trayClick.current = { id: tray.id, x: e.clientX, y: e.clientY }
      return
    }
    if (e.button !== 0 || isLocked(tray.id)) return
    e.stopPropagation()
    if (trayPick) {
      trayPick.onPick(tray.id)
      return
    }
    // A run "After placing" kept (not yet a tray of the draft) is not
    // edited here.
    const row = structRow(tray.id)
    if (!row || row.part !== "tray") return
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && onToggleStruct) {
      onToggleStruct(row.id)
      return
    }
    onSelectTray?.(tray.id)
    structG.runDown(row, e)
  }

  // "+" in tray edit mode: a bend in the middle of the segment, at once.
  const handleInsertBend = (
    tray: FloorPlanTray,
    segIndex: number,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    const row = structRow(tray.id)
    if (!row || row.part !== "tray") return
    const a = row.points[segIndex]
    const b = row.points[segIndex + 1]
    structureActions?.addBendAt?.(
      row.id,
      segIndex,
      Math.hypot(b[0] - a[0], b[1] - a[1]) / 2
    )
  }

  // Grab a wall body → select it (Shift or Ctrl/⌘: pick it to join) and
  // drag it whole.
  const handleWallDown = (wall: FloorPlanWall, e: React.PointerEvent) => {
    if (e.button !== 0 || isLocked(wall.id)) return
    e.stopPropagation()
    const row = structRow(wall.id)
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && onToggleStruct && row) {
      onToggleStruct(wall.id)
      return
    }
    onSelectWall?.(wall.id)
    onSelectDoor?.(null)
    if (row && row.part === "wall") structG.runDown(row, e)
  }

  /** Where the pointer falls along segment `seg` of a run, in cells. */
  const tAlong = (
    points: [number, number][],
    seg: number,
    e: { clientX: number; clientY: number }
  ) => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    const [ax, ay] = points[seg]
    const [bx, by] = points[seg + 1]
    const len = Math.hypot(bx - ax, by - ay) || 1
    const v =
      ((w.x / CELL - ax) * (bx - ax) + (w.y / CELL - ay) * (by - ay)) / len
    return Math.max(0, Math.min(len, v))
  }

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (svgRef.current) {
      const w = toWorld(svgRef.current, e.clientX, e.clientY)
      pointerAt.current = [w.x / CELL, w.y / CELL]
    }
    // Areas, labels and free tiles, and structure: their own gestures.
    if (shapeG.move(e)) return
    if (structG.move(e)) return
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
    if (structG.up(e)) return
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
    }
  }

  // A pinch takes over from whatever one finger began: the drag stops where
  // it is, a paint or sweep is dropped rather than committed, a structure
  // drag snaps back, and an open undo step closes.
  const cancelDrag = () => {
    shapeG.cancel()
    structG.cancel()
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
  }

  // Right-click → a small menu; hit-test which non-zone tile is under it.
  const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const wx = (e.clientX - rect.left - t.x) / t.k / CELL
    const wy = (e.clientY - rect.top - t.y) / t.k / CELL
    // View: a tray that carries cables gets its menu (Show cables).
    if (trayChooses && showTrays) {
      const slack = 6 / (CELL * t.k)
      let best: { id: string; d: number } | null = null
      for (const tray of trays) {
        if (tray.points.length < 2 || !trayCableIds(tray).length) continue
        const n = nearestSegment(tray.points, [wx, wy])
        const half = Math.max(5, 2 / t.k) / CELL
        if (n && n.dist <= half + slack && (!best || n.dist < best.d))
          best = { id: tray.id, d: n.dist }
      }
      if (best) {
        setTrayMenu({ x: e.clientX, y: e.clientY, id: best.id })
        return
      }
    }
    // Editing: a door, a wall or a tray under the pointer (they draw over
    // the rest), then a raised floor in Structure mode, get their own menu.
    if (editable && structureActions) {
      const slack = 6 / (CELL * t.k)
      const {
        walls: wallRows,
        trays: trayRows,
        raised,
      } = structureLists(structure)
      const runHit = (rows: RunRow[], extra: (r: RunRow) => number) => {
        let best: { row: RunRow; seg: number; t: number; d: number } | null =
          null
        for (const r of rows) {
          if (isLocked(r.id)) continue
          const n = nearestSegment(r.points, [wx, wy])
          if (n && n.dist <= extra(r) + slack && (!best || n.dist < best.d))
            best = { row: r, seg: n.seg, t: n.t, d: n.dist }
        }
        return best
      }
      const trayHit =
        showTrays && mode === "cable" ? runHit(trayRows, () => 5 / CELL) : null
      const wallHit = runHit(
        wallRows,
        (r) => wallStrokePx(r as FloorPlanWall, plan.cell_mm) / 2 / CELL
      )
      const hit = trayHit ?? wallHit
      if (hit) {
        const door =
          hit.row.part === "wall"
            ? hit.row.openings.findIndex(
                (o) => o.seg === hit.seg && hit.t >= o.from && hit.t <= o.to
              )
            : -1
        setStructMenu({
          x: e.clientX,
          y: e.clientY,
          id: hit.row.id,
          part: hit.row.part,
          seg: hit.seg,
          t: hit.t,
          door: door >= 0 ? door : undefined,
        })
        if (hit.row.part === "wall") {
          onSelectWall?.(hit.row.id)
          onSelectDoor?.(door >= 0 ? { wallId: hit.row.id, index: door } : null)
        } else onSelectTray?.(hit.row.id)
        return
      }
      const rf =
        mode === "structure"
          ? raised.find(
              (r) =>
                !isLocked(r.id) &&
                wx >= r.x &&
                wx <= r.x + r.width &&
                wy >= r.y &&
                wy <= r.y + r.height
            )
          : undefined
      if (rf) {
        setStructMenu({ x: e.clientX, y: e.clientY, id: rf.id, part: rf.part })
        onSelectArea?.(rf.id)
        return
      }
    }
    // Readable: a grown symbol draws over the areas and labels - it is
    // what the pointer is on.
    const grownHit = shapeOf
      ? readableHit(
          readableOrder(tiles, pxPerCell, pinnedNames, undefined, shapeOf),
          wx,
          wy,
          pxPerCell,
          undefined,
          shapeOf
        )
      : null
    if (grownHit && iconLayout.clusterOf.has(grownHit.id)) return
    if (grownHit && shapeOf?.(grownHit)?.changed) {
      setCtxMenu({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        tile: grownHit,
        at: [wx, wy],
      })
      return
    }
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
      at: [wx, wy],
    })
  }

  /** View: the topmost area or label with an Opens link under the pointer
   * names its target beside it - set only when that shape changes. */
  const hoverOpens = (e: React.PointerEvent<SVGSVGElement>) => {
    if (editable) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const p: Pt = [
      (e.clientX - rect.left - t.x) / t.k / CELL,
      (e.clientY - rect.top - t.y) / t.k / CELL,
    ]
    const hit = [...labels.slice().reverse(), ...areas.slice().reverse()].find(
      (s) =>
        (s.opens || s.opens_hidden) &&
        (s.kind === "area" && s.shape === "polygon"
          ? pointInPolygon(p, s.points)
          : pointInBox(p, s.kind === "label" ? labelBox(s, plan.cell_mm) : s))
    )
    if (!hit) {
      if (opensHint) setOpensHint(null)
      return
    }
    if (opensHint?.id === hit.id) return
    setOpensHint({
      id: hit.id,
      x: e.clientX - rect.left + 12,
      y: e.clientY - rect.top + 14,
      text: hit.opens ? `Opens ${opensName(hit)}` : "Opens a hidden plan",
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
    hoverStore.set(tile.id)
    onHoverTile?.(tile, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const leaveHover = () => {
    hoverStore.set(null)
    onHoverTile?.(null, null)
  }

  // Cables whose A↔B run touches a tile - for "trace cables here".
  const cablesTouching = (tileId: string) =>
    cablePaths
      .filter(
        (cp) => cp.a_tiles.includes(tileId) || cp.b_tiles.includes(tileId)
      )
      .map((cp) => cp.id)

  /** A click on a cluster: zoom to its members, close enough that they
   * part or turn back into tiles. */
  const fitCluster = (c: IconCluster) => {
    const rect = svgRef.current?.getBoundingClientRect()
    const members = c.members
      .map((id) => tileById.get(id))
      .filter((x): x is FloorPlanTile => !!x)
    if (!rect || !members.length) return
    setClusterHint(null)
    setT(
      clusterFitView(members, rect.width, rect.height, {
        cell: CELL,
        spacingPx: READABLE_SYMBOL_PX * 1.3,
        tilePx: ICON_TILE_EXIT_PX + 4,
        maxK: 4,
        // Room round the extent for the icons and their names.
        margin: 160,
      })
    )
  }

  const gridClipId = `fp-grid-clip-${plan.id}`
  // The tiles but zones and icons, in drawing order: at their real size
  // (clipped with the plan) and grown (Readable, in the overlays).
  const solidTiles = (() => {
    const ordered = readableOrder(
      free
        ? tiles
            .filter((tl) => !tileIsZone(tl))
            .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
        : tiles.filter((tl) => !tileIsZone(tl)),
      shapeOf ? pxPerCell : null,
      pinnedNames,
      undefined,
      shapeOf ?? undefined
    ).filter((tl) => !iconIds.has(tl.id))
    return splitGrown(ordered, shapeOf)
  })()

  /** One label on the plan. */
  const renderLabel = (l: LabelShape) => (
    <LabelShapeView
      key={l.id}
      label={l}
      cellMm={plan.cell_mm}
      minFontPx={readable ? READABLE_FONT_PX : undefined}
      zoom={t.k}
      // View: a label takes the pointer only to open its link.
      interactive={shapesLive && (editable ? !isLocked(l.id) : opensLabel(l))}
      viewing={!editable}
      onPointerDown={(e) => shapeG.shapeDown(l, e)}
    />
  )

  /** One tile on the plan. */
  const renderTile = (tile: FloorPlanTile) => {
    // A free plan draws a tile turned by what its angle has beyond
    // its quarter turn (shapes.ts tileResidual).
    const residual = free ? tileBox(tile).rotation : 0
    const shown = residual
      ? { ...tile, orientation: tileQuarter(tile.orientation) }
      : tile
    // Readable from afar: drawn grown about its centre (its saved geometry
    // untouched), its name left to the names layer, no resize grip - a
    // resize is done zoomed in, at the real size.
    const rs = shapeOf?.(tile) ?? null
    // Folded into a cluster: the cluster draws it.
    if (iconLayout.clusterOf.has(tile.id)) return null
    // An icon spread off its true place: drawn there and moved, so a new
    // layout eases it across.
    const iconHome = iconIds.has(tile.id)
      ? iconTileShape(tile, pxPerCell).box
      : null
    const shift =
      iconHome && rs
        ? [(rs.box.x - iconHome.x) * CELL, (rs.box.y - iconHome.y) * CELL]
        : null
    // Too thin, a photo too small to read, or an icon tile from afar: its
    // symbol instead.
    if (rs?.symbol)
      return (
        <g
          key={tile.id}
          pointerEvents={
            mode === "structure" || isLocked(tile.id) ? "none" : undefined
          }
          opacity={isLocked(tile.id) ? LOCKED_OPACITY : undefined}
          data-grown=""
          style={
            shift
              ? {
                  transform: `translate(${shift[0]}px, ${shift[1]}px)`,
                  transition: iconsSettled
                    ? "transform 180ms ease-out"
                    : undefined,
                }
              : undefined
          }
        >
          <ReadableSymbol
            tile={tile}
            box={iconHome ?? rs.box}
            k={t.k}
            selected={
              tile.id === selectedId || !!multiSelectedIds?.has(tile.id)
            }
            live={liveState?.tiles[tile.id]}
            colorBy={colorBy}
            figures={figures?.get(tile.id)}
            iconTile={iconIds.has(tile.id)}
            highlighted={
              !!highlightTileIds?.has(tile.id) ||
              !!tilePick?.picked.has(tile.id) ||
              calloutHot === tile.id
            }
            onPointerDown={(e) => handleTileDown(tile, e)}
            onDoubleClick={() => {
              if (mode !== "cable") onOpenTile?.(tile)
            }}
            onPointerEnter={(e) => reportHover(tile, e)}
            onPointerLeave={leaveHover}
          />
        </g>
      )
    const grow = rs?.changed ? rs.grow : 1
    const ccx = (tile.x + tile.width / 2) * CELL
    const ccy = (tile.y + tile.height / 2) * CELL
    const transform =
      [
        residual ? `rotate(${residual},${ccx},${ccy})` : "",
        grow > 1
          ? `translate(${ccx},${ccy}) scale(${grow}) translate(${-ccx},${-ccy})`
          : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined
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
        transform={transform}
        data-grown={grow > 1 ? "" : undefined}
      >
        <TileShape
          tile={shown}
          grip={!free && grow <= 1}
          hideName={planLabels.tileNamesHere.has(tile.id)}
          zoneNameGrow={
            readable && tileIsZone(tile) ? fontGrow(10, t.k) : undefined
          }
          handlePx={HANDLE_PX / t.k}
          selected={tile.id === selectedId || !!multiSelectedIds?.has(tile.id)}
          editable={editable}
          labelFit={labelFit}
          showZoneLabels={showZoneLabels}
          photoOutline={photoOutlines}
          live={liveState?.tiles[tile.id]}
          colorBy={colorBy}
          figures={figures?.get(tile.id)}
          highlighted={
            !!highlightTileIds?.has(tile.id) ||
            !!tilePick?.picked.has(tile.id) ||
            calloutHot === tile.id
          }
          dimmed={!!dimTileIds?.has(tile.id)}
          onPointerDown={(e) => handleTileDown(tile, e)}
          onResizeDown={(e) => handleResizeDown(tile, e)}
          // In Cables mode a double-click finishes a tray draw - don't
          // also open the tile's deep-view underneath it.
          onDoubleClick={() => {
            if (mode !== "cable") onOpenTile?.(tile)
          }}
          onPointerEnter={(e) => reportHover(tile, e)}
          onPointerLeave={leaveHover}
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
          // or paints. A drag still pans the plan. A corner handle of a
          // found outline drags itself.
          if (e.button !== 0) return
          if ((e.target as Element).closest("[data-outline-handle]")) return
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
          hoverOpens(e)
        }}
        onPointerCancel={pinchUp}
        onPointerUp={(e) => {
          if (pinchUp(e)) {
            pickStart.current = null
            return
          }
          const start = pickStart.current
          pickStart.current = null
          const tc = trayClick.current
          trayClick.current = null
          if (tc && Math.hypot(e.clientX - tc.x, e.clientY - tc.y) < 5)
            showTrayCables(tc.id, { x: e.clientX, y: e.clientY })
          if (
            start &&
            onPickPoint &&
            svgRef.current &&
            Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5
          )
            onPickPoint(toWorld(svgRef.current, e.clientX, e.clientY), {
              shiftKey: e.shiftKey,
            })
          handleUp(e)
        }}
        onPointerLeave={(e) => {
          pickStart.current = null
          pointerAt.current = null
          setOpensHint(null)
          setHint(null)
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
            (doorArmed && editable && mode === "structure") ||
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
          {((muteBackground && plan.background_image) ||
            (muteMap && mapImage)) && (
            <MuteFilter id={muteId} dark={theme === "dark"} />
          )}
        </defs>
        {clipToGrid && (
          <defs>
            <clipPath id={gridClipId}>
              <rect width={gw} height={gh} />
            </clipPath>
          </defs>
        )}
        <g
          transform={`translate(${t.x},${t.y}) scale(${t.k})`}
          clipPath={clipToGrid ? `url(#${gridClipId})` : undefined}
        >
          {/* Floor surface */}
          <rect width={gw} height={gh} className="fill-muted/30" rx={4} />
          {/* Two background layers: the base map (a Site map snapshot),
              then the floor's own picture or CAD drawing over it. */}
          {mapImage && (
            <image
              href={mapImage}
              data-layer="map"
              x={(backgroundFrame?.x ?? 0) * CELL}
              y={(backgroundFrame?.y ?? 0) * CELL}
              width={backgroundFrame ? backgroundFrame.width * CELL : gw}
              height={backgroundFrame ? backgroundFrame.height * CELL : gh}
              opacity={(plan.map_opacity ?? 60) / 100}
              preserveAspectRatio="none"
              filter={muteMap ? `url(#${muteId})` : undefined}
              data-muted={muteMap || undefined}
            />
          )}
          {plan.background_image && floorShown && (
            <image
              href={plan.background_image}
              data-layer="floor"
              x={(backgroundFrame?.x ?? 0) * CELL}
              y={(backgroundFrame?.y ?? 0) * CELL}
              width={backgroundFrame ? backgroundFrame.width * CELL : gw}
              height={backgroundFrame ? backgroundFrame.height * CELL : gh}
              opacity={plan.background_opacity / 100}
              preserveAspectRatio="none"
              filter={muteBackground ? `url(#${muteId})` : undefined}
              data-muted={muteBackground || undefined}
            />
          )}
          {floorShown && underlay}
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
            // While dragged or resized, as it will drop.
            const a = shownRow(raw)
            const labelText = `${a.label || "Raised floor"} · ${a.plenum_mm} mm`
            // ~5.6 px/char at 10px - hide the label when it would spill past
            // the area's edge (the rail always shows the full name).
            // Readable: never under READABLE_FONT_PX on screen, and shown
            // whatever it spills over.
            const rfGrow = readable ? fontGrow(10, t.k) : 1
            const labelFits =
              readable ||
              (a.width * CELL - 12 >= labelText.length * 5.6 &&
                a.height * CELL >= 20)
            const live = mode === "structure" && !isLocked(a.id) && !drawing
            return (
              <g
                key={a.id}
                data-raised={a.id}
                opacity={isLocked(a.id) ? LOCKED_OPACITY : undefined}
                onPointerDown={
                  live
                    ? (e) => {
                        if (e.button !== 0) return
                        e.stopPropagation()
                        onSelectArea?.(a.id)
                        const row = structRow(a.id)
                        if (row?.part === "raised_floor")
                          structG.rectDown(row, e)
                      }
                    : undefined
                }
                style={{
                  cursor: live ? (editable ? "move" : "pointer") : undefined,
                  pointerEvents: live ? "auto" : "none",
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
                {(a.label || a.id === selectedAreaId) &&
                  labelFits &&
                  !planLabels.hiddenRaised.has(a.id) && (
                    // Bottom-left: a room's name sits at its top-left, and a
                    // raised floor usually covers the room exactly.
                    <text
                      data-raised-label={a.id}
                      x={a.x * CELL + 6 * rfGrow}
                      y={(a.y + a.height) * CELL - 6 * rfGrow}
                      className="fill-muted-foreground"
                      fontSize={10 * rfGrow}
                      pointerEvents="none"
                    >
                      {labelText}
                    </text>
                  )}
              </g>
            )
          })}

          {onion && <OnionLayer skin={onion} />}
          {/* Zones first (background), then areas (rooms), then normal
              tiles, then FOV cones. */}
          {tiles.filter(tileIsZone).map(renderTile)}
          <g data-layer="areas">
            {areas.map((a) => (
              <AreaShapeView
                key={a.id}
                area={a}
                selected={a.id === selectedShapeId}
                zoom={t.k}
                minNamePx={readable ? READABLE_FONT_PX : undefined}
                nameAt={planLabels.areas.get(a.id)}
                interactive={shapesLive && !isLocked(a.id)}
                multiSelected={!!areaSel?.has(a.id)}
                onPointerDown={(e) => {
                  if (
                    editable &&
                    onToggleArea &&
                    e.button === 0 &&
                    (e.ctrlKey || e.metaKey)
                  ) {
                    e.stopPropagation()
                    onToggleArea(a.id)
                    return
                  }
                  shapeG.shapeDown(a, e)
                }}
                onEdgeDoubleClick={
                  editable && a.id === selectedShapeId
                    ? (seg, e) => shapeG.addVertex(a.id, seg, e)
                    : undefined
                }
              />
            ))}
          </g>
          {/* On a free plan tiles may overlap: their z says which is on
              top. Readable's grown symbols draw in the overlays. */}
          {solidTiles.real.map(renderTile)}
          {/* From afar a placed device, rack or cabinet keeps a marker in
              its colour where it would shrink to a dot - Readable grows
              the whole symbol instead. */}
          {!readable && !iconTiles && (
            <TileMarkers
              tiles={tiles}
              k={t.k}
              interactive={mode !== "structure"}
              isLocked={isLocked}
              onPointerDown={handleTileDown}
              onPointerEnter={reportHover}
              onPointerLeave={leaveHover}
            />
          )}

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
          {walls.map((w) => {
            const live = mode === "structure" && !drawing && !isLocked(w.id)
            return (
              <WallShape
                key={w.id}
                wall={shownRow(w)}
                cellMM={plan.cell_mm}
                selected={w.id === selectedWallId || !!structSel?.has(w.id)}
                interactive={live}
                doorArmed={doorArmed && editable}
                selectedDoor={
                  selectedDoor?.wallId === w.id ? selectedDoor.index : null
                }
                onBodyDown={(_seg, e) => handleWallDown(w, e)}
                onSegmentDown={(seg, e) => {
                  const row = structRow(w.id)
                  if (!row || row.part !== "wall") return
                  onSelectWall?.(w.id)
                  structG.doorDrawDown(row, seg, e)
                }}
                onSegmentDoubleClick={(seg, e) => {
                  if (!editable) return
                  e.stopPropagation()
                  structureActions?.splitAt?.(
                    w.id,
                    seg,
                    tAlong(w.points, seg, e)
                  )
                }}
                onDoorDown={(index, e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onSelectWall?.(w.id)
                  structG.doorSlideDown(w.id, index, e)
                }}
              />
            )
          })}

          {/* Cable trays - drawn above tiles so the run reads on a builder's
              print. Clickable in cable mode so layout editing is undisturbed;
              in View a click on one that carries cables lists them. */}
          {showTrays &&
            trays.map((tray) => {
              // In edit mode the SELECTED tray shows drag handles + "+" bend
              // inserters; all trays are draggable/selectable.
              const isEditing = trayEditMode && tray.id === selectedTrayId
              return (
                <TrayShape
                  key={tray.id}
                  tray={shownRow(tray)}
                  zoom={t.k}
                  readable={readable}
                  hideName
                  selected={
                    trayPick
                      ? trayPick.picked.includes(tray.id)
                      : tray.id === selectedTrayId || !!structSel?.has(tray.id)
                  }
                  interactive={
                    trayPick
                      ? !isLocked(tray.id)
                      : trayChooses
                        ? trayCableIds(tray).length > 0
                        : mode === "cable" && !drawing && !isLocked(tray.id)
                  }
                  editable={false}
                  editing={isEditing && editable}
                  dimmed={isLocked(tray.id)}
                  onPointerDown={(e) => handleTrayDown(tray, e)}
                  onDoubleClick={(e) => {
                    const row = structRow(tray.id)
                    if (!editable || !row || row.part !== "tray") return
                    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
                    const n = nearestSegment(row.points, [
                      w.x / CELL,
                      w.y / CELL,
                    ])
                    if (n) structureActions?.splitAt?.(row.id, n.seg, n.t)
                  }}
                  onVertexDown={() => {}}
                  onInsertBend={(seg, e) => handleInsertBend(tray, seg, e)}
                  onVertexContext={() => {}}
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
              interactive={!trayPick}
              onSelect={selectCable}
              onHover={hoverCable}
              onChoose={choosePicked}
              soloId={chooser ? chooserSolo : null}
              toPlan={clientToCell}
              previews={cablePreviews}
              stubs={shownStubs}
              tiles={tiles}
              shapeOf={shapeOf}
            />
          )}

          {/* A live view's room: the rest dimmed - over the plan, under
              the overlays. */}
          {maskOutline && (
            <AreaMask
              outline={maskOutline}
              width={plan.grid_width}
              height={plan.grid_height}
            />
          )}
        </g>

        {/* Screen-size overlays: grown symbols, icon tiles, the label
            pass's names and the labels that open a link. Over the plan's
            surround and a live view's dimming, never clipped to the grid -
            the layout keeps them inside where it can. */}
        <g
          data-layer="overlays"
          transform={`translate(${t.x},${t.y}) scale(${t.k})`}
        >
          {/* Readable: the grown symbols, the selection last. */}
          <g data-layer="grown-tiles">{solidTiles.over.map(renderTile)}</g>

          {/* Icons when zoomed out: over the trays and the cables that
              end on them - their leaders, the icons (the selection last)
              and the clusters. */}
          <g data-layer="icon-tiles">
            {/* Spread icons: a leader back to where each really is. */}
            {tiles.map((tl) => {
              if (!iconIds.has(tl.id) || iconLayout.clusterOf.has(tl.id))
                return null
              const o = iconLayout.offsets.get(tl.id)
              if (!o || Math.hypot(o[0], o[1]) < 2) return null
              const home: Pt = [tl.x + tl.width / 2, tl.y + tl.height / 2]
              return (
                <IconLeader
                  key={`leader-${tl.id}-${Math.round(o[0])}-${Math.round(o[1])}`}
                  from={drawnCentre(iconLayout, tl.id, home, pxPerCell)}
                  to={home}
                  k={t.k}
                />
              )
            })}
            {readableOrder(
              tiles.filter((tl) => iconIds.has(tl.id)),
              pxPerCell,
              pinnedNames,
              undefined,
              shapeOf ?? undefined
            ).map(renderTile)}
            {/* Icons folded together: one tile each, the count on it. */}
            {iconLayout.clusters.map((c) => {
              const face = clusterFaces.get(c.id)
              if (!face) return null
              return (
                <ClusterTile
                  key={c.id}
                  id={c.id}
                  box={clusterBox(c, pxPerCell)}
                  k={t.k}
                  face={face}
                  onActivate={() => fitCluster(c)}
                  onPointerEnter={(e) => {
                    const rect = svgRef.current?.getBoundingClientRect()
                    if (!rect || drag.current) return
                    setClusterHint({
                      id: c.id,
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                    })
                  }}
                  onPointerLeave={() => setClusterHint(null)}
                />
              )
            })}
          </g>

          {/* Every text the label pass places: cable names along their
              runs, trays' names, a focused cable's ends, Readable's tile
              names - one pass, the cables first (plan-label-pass.ts). */}
          <PlanLabelsLayer labels={planLabels} k={t.k} trays={trays} />

          {/* Callouts: names that would not sit cleanly by their tiles,
              in boxes off to the side with a leader each - hovered or
              selected with their tile, a press opens the tile. */}
          <PlanCalloutsLayer
            callouts={planLabels.callouts}
            k={t.k}
            hot={calloutHot ?? hoveredTile}
            selected={pinnedNames}
            colorOf={(id) => {
              const tile = tileById.get(id)
              return tile ? tileFill(tile) : undefined
            }}
            onHover={(id) => {
              if (!drag.current) setCalloutHot(id)
            }}
            onPress={pressCallout}
          />

          {/* Labels - over the tiles, so "North side" reads over a row.
              Clipped to the grid as the plan is, but for one that opens a
              link (a back label): never covered or cut. */}
          <g data-layer="labels">
            {labels.map((l) =>
              clipToGrid && !opensLabel(l) ? (
                <g key={l.id} clipPath={`url(#${gridClipId})`}>
                  {renderLabel(l)}
                </g>
              ) : (
                renderLabel(l)
              )
            )}
          </g>
        </g>

        {/* Editing on top: handles, previews, calibration marks. */}
        <g
          data-layer="edit-overlay"
          transform={`translate(${t.x},${t.y}) scale(${t.k})`}
          clipPath={clipToGrid ? `url(#${gridClipId})` : undefined}
        >
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

          {/* The selected wall's, tray's, raised floor's or door's handles. */}
          {structLive &&
            (() => {
              const out: React.ReactNode[] = []
              const run =
                mode === "structure" && selectedWallId && !selectedDoor
                  ? structRow(selectedWallId)
                  : mode === "cable" && selectedTrayId && !trayPick
                    ? structRow(selectedTrayId)
                    : undefined
              if (run && run.part !== "raised_floor" && !isLocked(run.id))
                out.push(
                  <RunHandles
                    key="run"
                    row={run}
                    zoom={t.k}
                    gestures={structG}
                    hint={showHint}
                    onVertexMenu={(index, ev) => {
                      ev.preventDefault()
                      ev.stopPropagation()
                      setStructMenu({
                        x: ev.clientX,
                        y: ev.clientY,
                        id: run.id,
                        part: run.part,
                        vertex: index,
                      })
                    }}
                  />
                )
              const rf =
                mode === "structure" && selectedAreaId
                  ? structRow(selectedAreaId)
                  : undefined
              if (rf?.part === "raised_floor" && !isLocked(rf.id))
                out.push(
                  <RectHandles
                    key="rf"
                    row={rf}
                    zoom={t.k}
                    gestures={structG}
                    hint={showHint}
                  />
                )
              const dw =
                mode === "structure" && selectedDoor
                  ? structRow(selectedDoor.wallId)
                  : undefined
              if (dw?.part === "wall" && selectedDoor && !isLocked(dw.id))
                out.push(
                  <DoorHandles
                    key="door"
                    wall={dw}
                    index={selectedDoor.index}
                    zoom={t.k}
                    gestures={structG}
                    hint={showHint}
                    onFlip={() =>
                      structureActions?.flipDoor?.(dw.id, selectedDoor.index)
                    }
                  />
                )
              return out
            })()}
          <StructureOverlay
            preview={structG.preview}
            walls={structureLists(structure).walls}
            zoom={t.k}
            width={gw}
            height={gh}
          />

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
        if (!editable || shapeTool || drawing) return null
        let b: ReturnType<typeof boxBounds> | null = null
        if (mode !== "layout") {
          if (!structureToolbar || structG.active()) return null
          const id =
            selectedDoor?.wallId ??
            (mode === "structure"
              ? (selectedWallId ?? selectedAreaId)
              : selectedTrayId)
          const r = id ? structRow(id) : undefined
          if (!r) return null
          b =
            r.part === "raised_floor"
              ? {
                  minX: r.x,
                  minY: r.y,
                  maxX: r.x + r.width,
                  maxY: r.y + r.height,
                }
              : pointsBoundsOf(r.points)
        } else if (!selectionToolbar) return null
        else if (areaSel && areaSel.size > 1) {
          const picked = shapes.filter((s) => areaSel.has(s.id))
          const all = picked.map((s) => shapeBounds(s, plan.cell_mm))
          if (all.length)
            b = {
              minX: Math.min(...all.map((x) => x.minX)),
              minY: Math.min(...all.map((x) => x.minY)),
              maxX: Math.max(...all.map((x) => x.maxX)),
              maxY: Math.max(...all.map((x) => x.maxY)),
            }
        } else if (selectedShape) b = shapeBounds(selectedShape, plan.cell_mm)
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
            {mode === "layout" ? selectionToolbar : structureToolbar}
          </div>
        )
      })()}

      {/* Hovering a cluster: its members. */}
      {clusterHint &&
        (() => {
          const c = iconLayout.clusters.find((x) => x.id === clusterHint.id)
          const face = c && clusterFaces.get(c.id)
          if (!c || !face) return null
          const names = c.members.map((id) => {
            const tl = tileById.get(id)
            return tl ? tileName(tl) || tl.linked?.name || "Tile" : ""
          })
          return (
            <Tooltip open>
              <TooltipTrigger asChild>
                <div
                  aria-hidden
                  className="pointer-events-none absolute"
                  style={{ left: clusterHint.x, top: clusterHint.y - 10 }}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                variant="panel"
                data-part="cluster-members"
              >
                <div className="flex flex-col">
                  <div className="font-medium">{face.name}</div>
                  <ul className="mt-0.5 text-xs text-muted-foreground">
                    {names.slice(0, 12).map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                    {names.length > 12 && <li>+{names.length - 12} more</li>}
                  </ul>
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })()}
      {opensHint && !editable && (
        <div
          role="status"
          data-part="opens-hint"
          className="pointer-events-none absolute z-20 rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-md"
          style={{ left: opensHint.x, top: opensHint.y }}
        >
          {opensHint.text}
        </div>
      )}

      {/* What dragging the handle under the pointer does. */}
      {hint && (
        <Tooltip open>
          <TooltipTrigger asChild>
            <div
              aria-hidden
              className="pointer-events-none absolute"
              style={{ left: hint.x, top: hint.y }}
            />
          </TooltipTrigger>
          <TooltipContent side="top" variant="default">
            {hint.text}
          </TooltipContent>
        </Tooltip>
      )}

      {/* A wall's, door's, tray's or raised floor's menu. */}
      <PointerMenu
        menu={structMenu}
        onClose={() => setStructMenu(null)}
        label="Structure"
        keys={(m) => ({
          Delete: () =>
            m.door !== undefined
              ? structureActions?.deleteDoor?.(m.id, m.door)
              : structureActions?.deleteRow?.(m.id),
        })}
      >
        {(m) => {
          const a = structureActions
          if (!a) return null
          const item = (label: string, fn?: () => void, destructive = false) =>
            fn ? (
              <DropdownMenuItem
                key={label}
                variant={destructive ? "destructive" : undefined}
                onSelect={fn}
              >
                {label}
              </DropdownMenuItem>
            ) : null
          if (m.part === "raised_floor")
            return item(
              "Delete raised floor",
              a.deleteRow && (() => a.deleteRow!(m.id)),
              true
            )
          if (m.vertex !== undefined) {
            const vertex = m.vertex
            const row = structure.find((r) => r.id === m.id)
            return (
              <DropdownMenuItem
                disabled={
                  !row || row.part === "raised_floor" || row.points.length <= 2
                }
                onSelect={() => a.removePoint?.(m.id, vertex)}
              >
                Remove point
              </DropdownMenuItem>
            )
          }
          if (m.door !== undefined) {
            const door = m.door
            return (
              <>
                {item(
                  "Flip swing",
                  a.flipDoor && (() => a.flipDoor!(m.id, door))
                )}
                <DropdownMenuSeparator />
                {item(
                  "Delete door",
                  a.deleteDoor && (() => a.deleteDoor!(m.id, door)),
                  true
                )}
              </>
            )
          }
          const seg = m.seg ?? 0
          const at = m.t ?? 0
          const row = structure.find((r) => r.id === m.id)
          // The other run picked, when the two meet end to end.
          const mate =
            row && row.part !== "raised_floor" && structSel
              ? structure.find(
                  (r) =>
                    r.id !== row.id &&
                    structSel.has(r.id) &&
                    r.part === row.part &&
                    runsTouch(r as RunRow, row)
                )
              : undefined
          return (
            <>
              {m.part === "tray" &&
                trays.some(
                  (tr) => tr.id === m.id && trayCableIds(tr).length > 0
                ) && (
                  <>
                    {item("Show cables", () =>
                      // After this menu has let the focus go.
                      window.setTimeout(() =>
                        showTrayCables(m.id, { x: m.x, y: m.y })
                      )
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
              {m.part === "wall" &&
                item(
                  "Add door here",
                  a.addDoorAt && (() => a.addDoorAt!(m.id, seg, at))
                )}
              {item(
                "Add bend here",
                a.addBendAt && (() => a.addBendAt!(m.id, seg, at))
              )}
              {item(
                "Split here",
                a.splitAt && (() => a.splitAt!(m.id, seg, at))
              )}
              {mate &&
                item(
                  m.part === "wall" ? "Join walls" : "Join trays",
                  a.join && (() => a.join!(mate.id, m.id))
                )}
              <DropdownMenuSeparator />
              {item(
                m.part === "wall" ? "Delete wall" : "Delete tray",
                a.deleteRow && (() => a.deleteRow!(m.id)),
                true
              )}
            </>
          )
        }}
      </PointerMenu>

      {/* View: a tray's menu. */}
      <PointerMenu
        menu={trayMenu}
        onClose={() => setTrayMenu(null)}
        label="Tray"
      >
        {(m) => {
          const tray = trays.find((tr) => tr.id === m.id)
          if (!tray) return null
          const n = trayCableIds(tray).length
          return (
            <>
              <DropdownMenuLabel className="truncate">
                {tray.name || "Tray"}
              </DropdownMenuLabel>
              <DropdownMenuItem
                disabled={n === 0}
                onSelect={() =>
                  window.setTimeout(() =>
                    showTrayCables(m.id, { x: m.x, y: m.y })
                  )
                }
              >
                Show cables
                <span className="num ml-auto text-xs text-muted-foreground">
                  {n}
                </span>
              </DropdownMenuItem>
            </>
          )
        }}
      </PointerMenu>

      {/* Which cable: a bundle's, a cluster's or a tray's. */}
      <CableChooser
        menu={chooser}
        cablePaths={cablePaths}
        colorBy={cableColorBy}
        onClose={() => setChooser(null)}
        onPreview={setChooserSolo}
        onPick={(id) => {
          setChooser(null)
          setChooserSolo(null)
          selectCable(id)
        }}
      />

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
              {s.kind === "area" && onSnapshotShape && (
                <DropdownMenuItem onSelect={() => onSnapshotShape(s.id)}>
                  {snapshotAreaLabel(s)}
                </DropdownMenuItem>
              )}
              {s.kind === "area" && structureActions?.wallsAround && (
                <DropdownMenuItem
                  onSelect={() => {
                    const ids =
                      areaSel && areaSel.size > 1 && areaSel.has(s.id)
                        ? [...areaSel]
                        : [s.id]
                    structureActions.wallsAround!(ids)
                  }}
                >
                  {areaSel && areaSel.size > 1 && areaSel.has(s.id)
                    ? `Add walls around these (${areaSel.size})`
                    : "Add walls around this"}
                </DropdownMenuItem>
              )}
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
            {!ctxMenu.tile &&
              ctxMenu.at &&
              emptyActions &&
              (() => {
                const at = ctxMenu.at
                const run = (fn?: (p: Pt) => void) => () => {
                  setCtxMenu(null)
                  fn?.(at)
                }
                const items = editable
                  ? [
                      ["Place device here…", emptyActions.placeAt],
                      ["Draw room/area here", emptyActions.drawAreaAt],
                      ["Detect outline here", emptyActions.detectAt],
                      ["Add label here", emptyActions.addLabelAt],
                      ["Paste", emptyActions.pasteAt],
                    ]
                  : [["Edit here", emptyActions.editHere]]
                const shown = items.filter(
                  (it): it is [string, (p: Pt) => void] => !!it[1]
                )
                if (!shown.length) return null
                return (
                  <>
                    {shown.map(([label, fn]) => (
                      <DropdownMenuItem key={label} onSelect={run(fn)}>
                        {label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </>
                )
              })()}
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
                {onConnectTile &&
                  ctxMenu.tile.linked &&
                  !ctxMenu.tile.linked.hidden &&
                  ["device", "rack", "cabinet"].includes(
                    ctxMenu.tile.linked.kind
                  ) && (
                    <DropdownMenuItem
                      onSelect={() => {
                        onConnectTile(ctxMenu.tile!)
                        setCtxMenu(null)
                      }}
                    >
                      Connect to…
                    </DropdownMenuItem>
                  )}
                {ctxMenu.tile.linked &&
                  !ctxMenu.tile.linked.hidden &&
                  onOpenTile && (
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
                {editable &&
                  onChangeTile &&
                  !isLocked(ctxMenu.tile.id) &&
                  (() => {
                    // A free plan's device tile to its measured width ×
                    // depth - only when asked, never by itself.
                    const rect = fitToSizeRect(ctxMenu.tile, plan)
                    if (!rect) return null
                    const id = ctxMenu.tile.id
                    return (
                      <DropdownMenuItem
                        onSelect={() => {
                          onChangeTile(id, rect)
                          setCtxMenu(null)
                        }}
                      >
                        Fit to size
                      </DropdownMenuItem>
                    )
                  })()}
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
