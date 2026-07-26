import {
  createFileRoute,
  Link,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router"
import type { ShouldBlockFn } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toPng } from "html-to-image"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Download,
  ExternalLink,
  Grid3x3,
  Image as ImageIcon,
  Maximize,
  PanelRight,
  Plus,
  RotateCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Spline,
  Trash2,
  Waypoints,
  X,
} from "lucide-react"
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Device,
  DeviceRole,
  FloorPlan,
  FloorPlanLinkKind,
  FloorPlanLiveState,
  FloorplanPopoverConfig,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTilesBulkPayload,
  FloorPlanTileWritePayload,
  FloorPlanTray,
  RaisedFloorArea,
  FloorPlanTrayWritePayload,
  FloorPlanWall,
  FloorPlanWallOpening,
  FloorPlanWallWritePayload,
  FloorTileStatus,
  FloorTileTypeOption,
  FovAnchor,
  Paginated,
  PowerPanelOption,
  Rack,
  TrayLevel,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorPicker } from "@/components/ui/color-picker"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { DevicePicker } from "@/components/device-picker"
import { DeviceMiniTopology } from "@/components/device-mini-topology"
import { CableAdd } from "@/components/cable-add"
import { DynamicIcon } from "@/components/dynamic-icon"
import { FloorPlanForm } from "@/components/floor-plan-form"
import {
  FloorCanvas,
  cableRoutePoints,
  findCollision,
  tileFill,
  tileHasFov,
  tileIsZone,
  tileName,
  utilizationColor,
} from "@/components/floorplan/floor-canvas"
import type {
  FloorCanvasApi,
  PaletteEntry,
} from "@/components/floorplan/floor-canvas"
import {
  DEFAULT_POPOVER_FIELDS,
  TilePopover,
  useTilePopover,
} from "@/components/floorplan/tile-popover"
import { ObjectsSidebar } from "@/components/floorplan/objects-sidebar"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { RackElevation } from "@/components/rack-elevation"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Slider } from "@/components/ui/slider"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormSelect,
} from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { RackPicker } from "@/components/rack-picker"
import { useTheme } from "@/components/theme-provider"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { apiErrorToast } from "@/lib/api-toast"
import { storedQualitySetting, storeQualitySetting } from "@/lib/render-quality"
import type { RenderQualitySetting } from "@/lib/render-quality"

/** Arms the canvas's drag-rect painter while drawing a raised-floor area —
 * the ghost rect reuses the palette machinery, nothing else reads this. */
const AREA_PSEUDO_ENTRY = {
  key: "structure:raised-floor",
  kind: "tile_type",
  id: "raised-floor",
  name: "Raised floor",
  color: "#71717a",
  icon: "",
  defaultWidth: 4,
  defaultHeight: 3,
  isZone: false,
  hasFov: false,
} as const satisfies import("@/components/floorplan/floor-canvas").PaletteEntry

/** 3D cabinet-shell modes — persisted in plan.state.shell_3d; anything else
 * stored there falls back to cutaway. */
const SHELL_MODES_3D = ["solid", "cutaway", "xray"] as const
type ShellMode3D = (typeof SHELL_MODES_3D)[number]

export const Route = createFileRoute("/floorplans/$id")({
  component: FloorPlanPage,
  // ?trace=<cableId> — arrive with a cable's route highlighted + fitted,
  // without entering Cables mode. ?viz=3d — open straight into the 3D room.
  // (Named `viz`, not `view` — the monitoring route owns `view` in the
  // router-wide search union and a second meaning breaks its reducer types.)
  validateSearch: (
    s: Record<string, unknown>
  ): { trace?: string; viz?: "3d" } => ({
    ...(typeof s.trace === "string" ? { trace: s.trace } : {}),
    ...(s.viz === "3d" ? { viz: "3d" as const } : {}),
  }),
})

// The 3D room view — the only consumer of the three.js stack, lazy-loaded so
// it lives in its own chunk and costs nothing until someone opens it.
const FloorScene3D = lazy(() => import("@/components/floorplan3d/scene"))

/** Local editing shape — server tiles plus unsaved ones (temp ids). */
type EditTile = FloorPlanTile

let tempCounter = 0
const tempId = () => `new-${++tempCounter}`
const isTemp = (id: string) => id.startsWith("new-")

/** Same page? Compared loosely so a trailing slash can't read as a move. */
const samePath = (a: string, b: string) =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "")

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "planned", label: "Planned" },
  { value: "reserved", label: "Reserved" },
  { value: "decommissioning", label: "Decommissioning" },
]

const LINK_KIND_OPTIONS = [
  { value: "rack", label: "Rack" },
  { value: "device", label: "Device" },
  { value: "powerpanel", label: "Power panel" },
  { value: "powerfeed", label: "Power feed" },
  { value: "floorplan", label: "Floor plan (nested)" },
]

function FloorPlanPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { canDo } = useMe()
  const { theme } = useTheme()
  const canEdit = canDo("floorplan", "change")

  const planQuery = useQuery({
    queryKey: ["floor-plan", id],
    queryFn: () => api<FloorPlan>(`/api/floor-plans/${id}/`),
  })
  const tilesQuery = useQuery({
    queryKey: ["floor-plan-tiles", id],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(
        `/api/floor-plan-tiles/?floor_plan=${id}&page_size=1000`
      ),
  })
  const tileTypes = useQuery({
    queryKey: ["floor-tile-types-picker"],
    queryFn: () =>
      api<Paginated<FloorTileTypeOption>>("/api/floor-tile-types/?picker=1"),
  })
  const roles = useQuery({
    queryKey: ["device-roles"],
    queryFn: () => api<Paginated<DeviceRole>>("/api/device-roles/"),
  })
  // Live per-tile metrics (rack utilization, monitoring rollup) — cheap to
  // poll; monitoring pushes state server-side so 30s keeps tiles honest.
  const liveState = useQuery({
    queryKey: ["floor-plan-state", id],
    queryFn: () => api<FloorPlanLiveState>(`/api/floor-plans/${id}/state/`),
    refetchInterval: 30_000,
  })
  // Which rows the tile popover shows (Settings → Deployment → Floor plans,
  // resolved per tenant). Any member may read it; falls back to the built-in
  // set while it loads or if it's unset.
  const popoverCfg = useQuery({
    queryKey: ["floorplan-popover"],
    queryFn: () => api<FloorplanPopoverConfig>("/api/floorplan-popover/"),
    staleTime: 5 * 60_000,
  })

  // Sibling plans of the same location — the "floors" of this building
  // (Floor 1 / Floor 2 / Basement…). Powers the header switcher.
  const locationId = planQuery.data?.location.id
  const floors = useQuery({
    queryKey: ["floor-plans", "location", locationId],
    queryFn: () =>
      api<Paginated<FloorPlan>>(
        `/api/floor-plans/?location=${locationId}&page_size=100`
      ),
    enabled: !!locationId,
  })

  const traysQuery = useQuery({
    queryKey: ["floor-plan-trays", id],
    queryFn: () =>
      api<Paginated<FloorPlanTray>>(
        `/api/floor-plan-trays/?floor_plan=${id}&page_size=500`
      ),
  })
  const trays = traysQuery.data?.results ?? []
  // Raised-floor areas (Structure mode) — rectangles with a plenum depth.
  const areasQuery = useQuery({
    queryKey: ["floor-plan-raised-floors", id],
    queryFn: () =>
      api<Paginated<RaisedFloorArea>>(
        `/api/floor-plan-raised-floors/?floor_plan=${id}&page_size=500`
      ),
  })
  const areas = areasQuery.data?.results ?? []
  // Walls (Structure mode) — polylines with door openings.
  const wallsQuery = useQuery({
    queryKey: ["floor-plan-walls", id],
    queryFn: () =>
      api<Paginated<FloorPlanWall>>(
        `/api/floor-plan-walls/?floor_plan=${id}&page_size=500`
      ),
  })
  const walls = wallsQuery.data?.results ?? []
  const cablePathsQuery = useQuery({
    queryKey: ["floor-plan-cable-paths", id],
    queryFn: () =>
      api<{ cables: FloorPlanCablePath[] }>(
        `/api/floor-plans/${id}/cable-paths/`
      ),
  })
  const cablePaths = cablePathsQuery.data?.cables ?? []
  const { trace: traceParam, viz: vizParam } = Route.useSearch()
  const view3d = vizParam === "3d"
  const [show3dHint, setShow3dHint] = useState(true)

  // ── Local editing state ────────────────────────────────────────────────
  const [tiles, setTiles] = useState<EditTile[]>([])
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set())
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [armed, setArmed] = useState<PaletteEntry | null>(null)
  // Structure mode: arm-to-draw a raised-floor rectangle + selection.
  const [areaArmed, setAreaArmed] = useState(false)
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  // Structure mode: wall selection + "Add door" arm-and-click.
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null)
  const [doorArmed, setDoorArmed] = useState(false)
  // Layout QoL: Ctrl/⌘-click and Shift-drag build a multi-selection the bulk
  // bar (orientation, delete) acts on. Draft-level edits — Save persists.
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set())
  const [paletteTab, setPaletteTab] = useState<"tiles" | "zones">("tiles")
  const [showGrid, setShowGrid] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Deep view: the rack/device contents + end-to-end trace side sheet.
  const [deepTile, setDeepTile] = useState<FloorPlanTile | null>(null)
  // View prefs — seeded from plan.state, persisted back for editors.
  const [labelFitLocal, setLabelFitLocal] = useState<boolean | null>(null)
  const [showFovLocal, setShowFovLocal] = useState<boolean | null>(null)
  const [showZoneLabelsLocal, setShowZoneLabelsLocal] = useState<
    boolean | null
  >(null)
  const [showTraysLocal, setShowTraysLocal] = useState<boolean | null>(null)
  const [showLinksLocal, setShowLinksLocal] = useState<boolean | null>(null)
  const [showObjectsLocal, setShowObjectsLocal] = useState<boolean | null>(null)
  // 3D overlay prefs — same persistence pattern as the 2D ones.
  const [show3dULocal, setShow3dULocal] = useState<boolean | null>(null)
  const [show3dNamesLocal, setShow3dNamesLocal] = useState<boolean | null>(null)
  const [show3dCablesLocal, setShow3dCablesLocal] = useState<boolean | null>(
    null
  )
  const [show3dAirflowLocal, setShow3dAirflowLocal] = useState<boolean | null>(
    null
  )
  const [floorPeekLocal, setFloorPeekLocal] = useState<boolean | null>(null)
  const [show3dWallsLocal, setShow3dWallsLocal] = useState<boolean | null>(null)
  const [show3dCeilingLocal, setShow3dCeilingLocal] = useState<boolean | null>(
    null
  )
  // Cabinet shell (3D): solid / cutaway / x-ray — a mode, not a checkbox.
  const [shell3dLocal, setShell3dLocal] = useState<ShellMode3D | null>(null)
  // 3D effects budget — PER-DEVICE (localStorage), not a plan pref: the
  // workstation's High must not follow the plan onto a weak laptop.
  const [quality3d, setQuality3dState] = useState<RenderQualitySetting>(() =>
    storedQualitySetting()
  )
  const setQuality3d = (v: RenderQualitySetting) => {
    setQuality3dState(v)
    storeQualitySetting(v)
  }
  const [highlightCableIds, setHighlightCableIds] = useState<string[]>([])
  // Tile popover: hover-preview (delayed) + click-to-pin.
  const popover = useTilePopover()
  // Resolve the row list for the tile in hand: a tile type with its own list
  // wins, otherwise it INHERITS the global one (absence = inherit, so the two
  // can never drift apart).
  const popoverFields = useMemo(() => {
    const cfg = popoverCfg.data
    if (!cfg) return DEFAULT_POPOVER_FIELDS
    const slug = popover.target?.tile.tile_type?.slug
    return (slug && cfg.tile_overrides[slug]) || cfg.fields
  }, [popoverCfg.data, popover.target])
  // Tray edit mode: hide cables + let every tray be reshaped. A toggle.
  const [trayEditMode, setTrayEditMode] = useState(false)
  // Editor mode: layout (tiles) vs cable (trays).
  const [mode, setMode] = useState<"layout" | "cable" | "structure">("layout")
  const [selectedTrayId, setSelectedTrayId] = useState<string | null>(null)
  // Tray drawing: null when idle, else the in-progress vertex list.
  const [drawPoints, setDrawPoints] = useState<[number, number][] | null>(null)
  // Finished-but-unnamed tray awaiting its name.
  const [namingPoints, setNamingPoints] = useState<[number, number][] | null>(
    null
  )
  const [search, setSearch] = useState("")
  const canvasApi = useRef<FloorCanvasApi | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const isDirty = dirtyIds.size > 0 || deletedIds.size > 0
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty

  // ── Unsaved-edit guard ─────────────────────────────────────────────────
  // One dialog for every in-app way out of a dirty editor: sidebar links,
  // breadcrumbs, browser back/forward, the "leave plan" links on tiles, and the
  // floor switcher (which just navigates, like everything else). The router's
  // blocker is the single decision point — the switcher deliberately has no
  // confirm of its own, because two guards on one action means two dialogs.
  //
  // Same-pathname navigations are let through on purpose: this page drives
  // ?viz=3d and clears ?trace= through the router, and a view toggle is not an
  // exit. Only a different pathname means the edits are about to be dropped.
  //
  // shouldBlockFn is a dependency of the hook's own effect, so it reads the ref
  // and stays referentially stable — an inline closure would tear down and
  // re-register the history blocker on every render.
  const shouldBlockLeave = useCallback<ShouldBlockFn>(
    ({ current, next }) =>
      isDirtyRef.current && !samePath(next.pathname, current.pathname),
    []
  )
  // withResolver hands back proceed/reset, which the themed AlertDialog at the
  // end of this component drives — a native window.confirm can't be styled and
  // reads as a browser error. enableBeforeUnload stays off because the blocker
  // is registered whether or not the plan is dirty; the ref-gated listener
  // below owns the browser-level case, which no router blocker can reach.
  const leaveGuard = useBlocker({
    shouldBlockFn: shouldBlockLeave,
    enableBeforeUnload: false,
    withResolver: true,
  })

  // Switching floors re-uses this mounted component — reset every bit of
  // editor state so one floor's unsaved edits can never bleed into another.
  useEffect(() => {
    setTiles([])
    setDirtyIds(new Set())
    setDeletedIds(new Set())
    setSelectedId(null)
    setArmed(null)
    setDeepTile(null)
    setLabelFitLocal(null)
    setShowFovLocal(null)
    setMode("layout")
    setSelectedTrayId(null)
    setDrawPoints(null)
    setNamingPoints(null)
    setShowTraysLocal(null)
    setShowLinksLocal(null)
    setHighlightCableIds([])
    setTrayEditMode(false)
    setAreaArmed(false)
    setSelectedAreaId(null)
    setSelectedWallId(null)
    setDoorArmed(false)
    setShell3dLocal(null)
  }, [id])

  // Hydrate local tiles from the server whenever fresh data lands and we
  // have no unsaved edits (so a background refetch never clobbers work).
  useEffect(() => {
    if (tilesQuery.data && !isDirtyRef.current) {
      setTiles(tilesQuery.data.results)
    }
  }, [tilesQuery.data])

  // Closing the tab, reloading, or leaving for another origin would drop
  // unsaved tile edits without a word, and those never reach the router — so
  // the browser's own leave-site prompt is the only guard that covers them.
  // In-app navigation is the blocker's job, above. Registered only while dirty,
  // and it reads the ref so a stale closure can never make the guard lie.
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [isDirty])

  const selected = tiles.find((t) => t.id === selectedId) ?? null
  const selectedTray = trays.find((t) => t.id === selectedTrayId) ?? null

  const palette = useMemo<PaletteEntry[]>(() => {
    const fromTypes = (tileTypes.data?.results ?? []).map(
      (tt): PaletteEntry => ({
        key: `tt:${tt.id}`,
        kind: "tile_type",
        id: tt.id,
        name: tt.name,
        color: tt.color,
        icon: tt.icon,
        defaultWidth: tt.default_width,
        defaultHeight: tt.default_height,
        isZone: tt.is_zone,
        hasFov: tt.has_fov,
      })
    )
    const fromRoles = (roles.data?.results ?? []).map(
      (r): PaletteEntry => ({
        key: `role:${r.id}`,
        kind: "role",
        id: r.id,
        name: r.name,
        color: r.color,
        icon: "",
        defaultWidth: 1,
        defaultHeight: 1,
        isZone: false,
        hasFov: r.has_fov,
      })
    )
    return [...fromTypes, ...fromRoles]
  }, [tileTypes.data, roles.data])

  const shownPalette = palette.filter((p) =>
    paletteTab === "zones" ? p.isZone : !p.isZone
  )

  const changeTile = useCallback(
    (tileId: string, patch: Partial<FloorPlanTile>) => {
      setTiles((prev) =>
        prev.map((t) => (t.id === tileId ? { ...t, ...patch } : t))
      )
      setDirtyIds((prev) =>
        prev.has(tileId) ? prev : new Set(prev).add(tileId)
      )
    },
    []
  )

  // Geometry edits (canvas drags, nudges, resizes) refuse to stack tiles —
  // the candidate rect must be free of other non-zone tiles. Zones are
  // background and may overlap anything.
  const changeTileGuarded = useCallback(
    (tileId: string, patch: Partial<FloorPlanTile>) => {
      const touchesGeometry =
        "x" in patch || "y" in patch || "width" in patch || "height" in patch
      if (touchesGeometry) {
        const tile = tiles.find((t) => t.id === tileId)
        if (tile && !tileIsZone(tile)) {
          const rect = {
            x: patch.x ?? tile.x,
            y: patch.y ?? tile.y,
            width: patch.width ?? tile.width,
            height: patch.height ?? tile.height,
          }
          if (findCollision(tiles, rect, tileId)) return
        }
      }
      changeTile(tileId, patch)
    },
    [tiles, changeTile]
  )

  const plan = planQuery.data

  // View prefs: seeded from the plan's saved state; editors persist toggles.
  const labelFit = labelFitLocal ?? Boolean(plan?.state.label_fit)
  const showFov =
    showFovLocal ?? (plan?.state.show_fov as boolean | undefined) ?? true
  const showZoneLabels =
    showZoneLabelsLocal ??
    (plan?.state.show_zone_labels as boolean | undefined) ??
    true
  const showTrays =
    showTraysLocal ?? (plan?.state.show_trays as boolean | undefined) ?? true
  const showCableLinks =
    showLinksLocal ??
    (plan?.state.show_cable_links as boolean | undefined) ??
    false
  const showObjects =
    showObjectsLocal ??
    (plan?.state.show_objects as boolean | undefined) ??
    false
  const show3dU =
    show3dULocal ?? (plan?.state.show_3d_u as boolean | undefined) ?? false
  const show3dNames =
    show3dNamesLocal ??
    (plan?.state.show_3d_names as boolean | undefined) ??
    false
  const show3dCables =
    show3dCablesLocal ??
    (plan?.state.show_3d_cables as boolean | undefined) ??
    false
  const show3dAirflow =
    show3dAirflowLocal ??
    (plan?.state.show_3d_airflow as boolean | undefined) ??
    false
  const floorPeek =
    floorPeekLocal ??
    (plan?.state.show_3d_floor_peek as boolean | undefined) ??
    false
  // Walls default ON: a wall someone drew must show up without a hunt
  // through the View popover — hiding the shell is the deliberate act.
  const show3dWalls =
    show3dWallsLocal ??
    (plan?.state.show_3d_walls as boolean | undefined) ??
    true
  const show3dCeiling =
    show3dCeilingLocal ??
    (plan?.state.show_3d_ceiling as boolean | undefined) ??
    false
  const shell3dRaw =
    shell3dLocal ?? (plan?.state.shell_3d as string | undefined) ?? "cutaway"
  const shell3d: ShellMode3D = SHELL_MODES_3D.includes(
    shell3dRaw as ShellMode3D
  )
    ? (shell3dRaw as ShellMode3D)
    : "cutaway"
  const setShellMode = (v: ShellMode3D) => {
    setShell3dLocal(v)
    if (canEdit && plan)
      patchPlan.mutate({ state: { ...plan.state, shell_3d: v } })
  }

  // ?trace=<cableId> → highlight that cable + fit the view to its route, so a
  // "trace on map" link from a cable/rack lands on the run without any clicks.
  const tracedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!traceParam || tracedRef.current === traceParam) return
    const cp = cablePaths.find((c) => c.id === traceParam)
    if (!cp) return // paths not loaded yet — the effect re-runs when they land
    tracedRef.current = traceParam
    setShowLinksLocal(true)
    setHighlightCableIds([traceParam])
    const route = cableRoutePoints(cp, trays, tiles)
    if (route.length >= 2)
      requestAnimationFrame(() => canvasApi.current?.focusPoints(route))
  }, [traceParam, cablePaths, trays, tiles])

  const setViewPref = (
    key:
      | "label_fit"
      | "show_fov"
      | "show_zone_labels"
      | "show_trays"
      | "show_cable_links"
      | "show_objects"
      | "show_3d_u"
      | "show_3d_names"
      | "show_3d_cables"
      | "show_3d_airflow"
      | "show_3d_floor_peek"
      | "show_3d_walls"
      | "show_3d_ceiling",
    value: boolean
  ) => {
    if (key === "label_fit") setLabelFitLocal(value)
    else if (key === "show_fov") setShowFovLocal(value)
    else if (key === "show_zone_labels") setShowZoneLabelsLocal(value)
    else if (key === "show_trays") setShowTraysLocal(value)
    else if (key === "show_objects") setShowObjectsLocal(value)
    else if (key === "show_3d_u") setShow3dULocal(value)
    else if (key === "show_3d_names") setShow3dNamesLocal(value)
    else if (key === "show_3d_cables") setShow3dCablesLocal(value)
    else if (key === "show_3d_airflow") setShow3dAirflowLocal(value)
    else if (key === "show_3d_floor_peek") setFloorPeekLocal(value)
    else if (key === "show_3d_walls") setShow3dWallsLocal(value)
    else if (key === "show_3d_ceiling") setShow3dCeilingLocal(value)
    else setShowLinksLocal(value)
    if (canEdit && plan)
      patchPlan.mutate({ state: { ...plan.state, [key]: value } })
  }

  const invalidateAreas = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan-raised-floors", id] })
    qc.invalidateQueries({ queryKey: ["floor-plan-scene", id] })
  }
  const createArea = useMutation({
    mutationFn: (rect: { x: number; y: number; w: number; h: number }) =>
      api<RaisedFloorArea>("/api/floor-plan-raised-floors/", {
        method: "POST",
        body: JSON.stringify({
          floor_plan_id: id,
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
        }),
      }),
    onSuccess: (a) => {
      invalidateAreas()
      setSelectedAreaId(a.id)
      setAreaArmed(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  const patchArea = useMutation({
    mutationFn: ({
      areaId,
      body,
    }: {
      areaId: string
      body: Partial<RaisedFloorArea>
    }) =>
      api<RaisedFloorArea>(`/api/floor-plan-raised-floors/${areaId}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      invalidateAreas()
      // Structure edits persist immediately (tray-style) — without a word,
      // the page's Save-button mental model reads that as "not saved".
      toast.success("Raised floor saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  const deleteArea = useMutation({
    mutationFn: (areaId: string) =>
      api<void>(`/api/floor-plan-raised-floors/${areaId}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidateAreas()
      setSelectedAreaId(null)
    },
    onError: (e) => apiErrorToast(e),
  })
  /** Structure mode: a completed drag-rect becomes a raised-floor area. */
  const createAreaAt = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!areaArmed || !plan) return
      createArea.mutate(rect)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [areaArmed, plan, id]
  )

  // ── Walls (instant-save, tray-style) ───────────────────────────────────
  const invalidateWalls = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan-walls", id] })
    qc.invalidateQueries({ queryKey: ["floor-plan-scene", id] })
  }
  const createWall = useMutation({
    mutationFn: (payload: FloorPlanWallWritePayload) =>
      api<FloorPlanWall>("/api/floor-plan-walls/", {
        method: "POST",
        body: JSON.stringify({ ...payload, floor_plan_id: id }),
      }),
    onSuccess: (w) => {
      invalidateWalls()
      setSelectedWallId(w.id)
      toast.success("Wall added")
    },
    onError: (e) => apiErrorToast(e),
  })
  const patchWall = useMutation({
    mutationFn: ({
      wallId,
      body,
    }: {
      wallId: string
      body: FloorPlanWallWritePayload
    }) =>
      api<FloorPlanWall>(`/api/floor-plan-walls/${wallId}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      invalidateWalls()
      // Same contract as areas: instant-save needs a word, or the page's
      // Save-button mental model reads it as "not saved".
      toast.success("Wall saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  const deleteWall = useMutation({
    mutationFn: (wallId: string) =>
      api<void>(`/api/floor-plan-walls/${wallId}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateWalls()
      setSelectedWallId(null)
    },
    onError: (e) => apiErrorToast(e),
  })
  /** "Add door" click: a 900 mm opening centred on the clicked spot, clamped
   * into the segment (the server validates overlap and bounds). */
  const placeDoor = useCallback(
    (wallId: string, seg: number, at: number) => {
      const wall = walls.find((w) => w.id === wallId)
      if (!wall || !plan) return
      const [ax, ay] = wall.points[seg]
      const [bx, by] = wall.points[seg + 1]
      const segLen = Math.hypot(bx - ax, by - ay)
      const w = 900 / plan.cell_mm
      if (segLen < w) {
        toast.error("This wall segment is too short for a door.")
        return
      }
      const from = Math.max(0, Math.min(segLen - w, at - w / 2))
      const opening: FloorPlanWallOpening = {
        seg,
        from: Math.round(from * 100) / 100,
        to: Math.round((from + w) * 100) / 100,
        height_mm: null,
      }
      patchWall.mutate({
        wallId,
        body: { openings: [...wall.openings, opening] },
      })
      setDoorArmed(false)
      setSelectedWallId(wallId)
    },
    [walls, plan, patchWall.mutate]
  )

  const createAt = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!armed || !plan) return
      // A plain click paints a 1×1 rect — use the palette entry's default
      // footprint there; an actual drag wins.
      const w =
        rect.w === 1 && rect.h === 1
          ? Math.min(armed.defaultWidth, plan.grid_width - rect.x)
          : rect.w
      const h =
        rect.w === 1 && rect.h === 1
          ? Math.min(armed.defaultHeight, plan.grid_height - rect.y)
          : rect.h
      const candidate = {
        x: rect.x,
        y: rect.y,
        width: Math.max(1, w),
        height: Math.max(1, h),
      }
      // Zones may cover anything; normal tiles never stack.
      if (!armed.isZone && findCollision(tiles, candidate)) {
        toast.error("Tiles can't stack — that spot is taken.")
        return
      }
      const now = new Date().toISOString()
      const tile: EditTile = {
        id: tempId(),
        ...candidate,
        tile_type:
          armed.kind === "tile_type"
            ? {
                id: armed.id,
                name: armed.name,
                slug: "",
                color: armed.color,
                icon: armed.icon,
                default_width: armed.defaultWidth,
                default_height: armed.defaultHeight,
                is_zone: armed.isZone,
                has_fov: armed.hasFov,
              }
            : null,
        role_type:
          armed.kind === "role"
            ? {
                id: armed.id,
                name: armed.name,
                slug: "",
                color: armed.color,
                is_patch_panel: false,
                has_fov: armed.hasFov,
              }
            : null,
        orientation: 0,
        label: "",
        color: "",
        status: "",
        link_kind: "",
        linked: null,
        // Camera types start with a visible cone so the controls make sense.
        fov_deg: armed.hasFov ? 90 : null,
        fov_distance: armed.hasFov ? 3 : null,
        fov_direction: armed.hasFov ? 0 : null,
        fov_anchor: "",
        fov_ptz: false,
        created_at: now,
        updated_at: now,
      }
      setTiles((prev) => [...prev, tile])
      setDirtyIds((prev) => new Set(prev).add(tile.id))
      setSelectedId(tile.id)
    },
    [armed, plan, tiles]
  )

  const deleteTile = useCallback((tileId: string) => {
    setTiles((prev) => prev.filter((t) => t.id !== tileId))
    setDirtyIds((prev) => {
      const next = new Set(prev)
      next.delete(tileId)
      return next
    })
    if (!isTemp(tileId)) setDeletedIds((prev) => new Set(prev).add(tileId))
    setSelectedId((cur) => (cur === tileId ? null : cur))
  }, [])

  // Set an absolute facing (orientation). A quarter-turn (90/270 delta) swaps
  // the grid footprint — same invariant the relative rotate keeps.
  const setTileFacing = useCallback(
    (tile: EditTile, orientation: EditTile["orientation"]) => {
      if (!plan || orientation === tile.orientation) return
      const quarter = (orientation - tile.orientation + 360) % 180 !== 0
      const width = quarter ? tile.height : tile.width
      const height = quarter ? tile.width : tile.height
      const rect = {
        width,
        height,
        x: Math.min(tile.x, Math.max(0, plan.grid_width - width)),
        y: Math.min(tile.y, Math.max(0, plan.grid_height - height)),
      }
      if (quarter && !tileIsZone(tile) && findCollision(tiles, rect, tile.id)) {
        toast.error("No room to rotate — a neighbour is in the way.")
        return
      }
      changeTile(tile.id, { orientation, ...rect })
    },
    [changeTile, plan, tiles]
  )

  const rotateTile = useCallback(
    (tile: EditTile) =>
      setTileFacing(
        tile,
        ((tile.orientation + 90) % 360) as EditTile["orientation"]
      ),
    [setTileFacing]
  )

  const addDrawPoint = useCallback((pt: [number, number]) => {
    setDrawPoints((prev) => {
      const arr = prev ?? []
      // Skip a duplicate of the last vertex (e.g. the extra click a
      // double-click-to-finish produces), so trays don't get zero-length hops.
      const last = arr.length ? arr[arr.length - 1] : null
      if (last && last[0] === pt[0] && last[1] === pt[1]) return arr
      return [...arr, pt]
    })
  }, [])
  // One polyline rig, two products: Cables mode finishes into the tray
  // naming dialog; Structure mode creates the wall at once (label is
  // optional — the inspector opens on it for the rest).
  const finishDraw = useCallback(() => {
    setDrawPoints((prev) => {
      if (prev && prev.length >= 2) {
        if (mode === "structure") createWall.mutate({ points: prev })
        else setNamingPoints(prev)
      }
      return null
    })
  }, [mode, createWall.mutate])

  // Keyboard: Delete removes the selection, Escape disarms/deselects,
  // arrows nudge. Skipped while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Escape") {
        // An active ?trace= wins: first Esc stops the trace (2D and 3D).
        if (traceParam) {
          void nav({
            to: ".",
            search: (s: Record<string, unknown>) => ({
              ...s,
              trace: undefined,
            }),
            replace: true,
          })
          setHighlightCableIds([])
          tracedRef.current = null
          return
        }
        // In tray edit mode? First Esc just leaves it.
        if (trayEditMode) {
          setTrayEditMode(false)
          return
        }
        setArmed(null)
        setSelectedId(null)
        setSelectedTrayId(null)
        setSelectedWallId(null)
        setDrawPoints(null)
        return
      }
      if (e.key === "Escape" && doorArmed) {
        setDoorArmed(false)
        return
      }
      if (e.key === "Escape" && areaArmed) {
        setAreaArmed(false)
        return
      }
      if (e.key === "Escape" && multiSel.size > 0) {
        setMultiSel(new Set())
        return
      }
      // Enter finishes an in-progress polyline (tray or wall).
      if (
        (mode === "cable" || mode === "structure") &&
        drawPoints !== null &&
        e.key === "Enter"
      ) {
        e.preventDefault()
        finishDraw()
        return
      }
      // In the 3D view the camera rig owns arrows (and a 2D tile selection
      // is invisible) — don't nudge/delete a tile nobody can see.
      if (!canEdit || !selectedId || view3d) return
      const tile = tiles.find((t) => t.id === selectedId)
      if (!tile || !plan) return
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        deleteTile(selectedId)
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault()
        const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
        const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
        changeTileGuarded(selectedId, {
          x: Math.max(0, Math.min(plan.grid_width - tile.width, tile.x + dx)),
          y: Math.max(0, Math.min(plan.grid_height - tile.height, tile.y + dy)),
        })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    canEdit,
    selectedId,
    tiles,
    plan,
    deleteTile,
    changeTileGuarded,
    mode,
    drawPoints,
    finishDraw,
    trayEditMode,
    traceParam,
    nav,
    view3d,
    areaArmed,
    doorArmed,
    multiSel,
  ])

  // ── Save (explicit, one bulk transaction) ──────────────────────────────
  const save = useMutation({
    mutationFn: async () => {
      const body = (t: EditTile): FloorPlanTileWritePayload => ({
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        tile_type_id: t.tile_type?.id ?? null,
        role_type_id: t.role_type?.id ?? null,
        orientation: t.orientation,
        label: t.label,
        color: t.color,
        status: t.status,
        link_kind: t.linked ? t.linked.kind : "",
        link_id: t.linked?.id ?? "",
        fov_deg: t.fov_deg,
        fov_distance: t.fov_distance,
        fov_direction: t.fov_direction,
        fov_anchor: t.fov_anchor,
        fov_ptz: t.fov_ptz,
      })
      const payload: FloorPlanTilesBulkPayload = {
        create: tiles.filter((t) => isTemp(t.id)).map(body),
        update: tiles
          .filter((t) => !isTemp(t.id) && dirtyIds.has(t.id))
          .map((t) => ({ id: t.id, ...body(t) })),
        delete: [...deletedIds],
      }
      return api<FloorPlanTile[]>(`/api/floor-plans/${id}/tiles/bulk/`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (fresh) => {
      setTiles(fresh)
      setDirtyIds(new Set())
      setDeletedIds(new Set())
      setSelectedId(null)
      qc.invalidateQueries({ queryKey: ["floor-plan-tiles", id] })
      qc.invalidateQueries({ queryKey: ["floor-plan", id] })
      qc.invalidateQueries({ queryKey: ["floor-plans"] })
      // Tile moves change cable endpoints — refresh the routed paths too.
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", id] })
      toast.success("Floor plan saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  // ── Background image upload / opacity ──────────────────────────────────
  const uploadBackground = useMutation({
    mutationFn: async (file: File | null) => {
      const fd = new FormData()
      if (file) fd.append("background_image", file)
      else fd.append("clear", "1")
      return api<FloorPlan>(`/api/floor-plans/${id}/background/`, {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["floor-plan", id] }),
    onError: (err) => apiErrorToast(err),
  })

  const patchPlan = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<FloorPlan>(`/api/floor-plans/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["floor-plan", id] }),
    onError: (err) => apiErrorToast(err),
  })

  // ── Trays (save immediately per op — no bulk/dirty model like tiles) ────
  const invalidateTrays = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan-trays", id] })
    // A cable's route depends on its trays — refresh the routed paths so
    // links don't fall back to point-to-point until a reload.
    qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", id] })
  }
  const createTray = useMutation({
    mutationFn: (payload: FloorPlanTrayWritePayload) =>
      api<FloorPlanTray>("/api/floor-plan-trays/", {
        method: "POST",
        body: JSON.stringify({ ...payload, floor_plan_id: id }),
      }),
    onSuccess: (tray) => {
      invalidateTrays()
      setSelectedTrayId(tray.id)
      toast.success(`Added ${tray.name}`)
    },
    onError: (err) => apiErrorToast(err),
  })
  const patchTray = useMutation({
    mutationFn: ({
      trayId,
      patch,
    }: {
      trayId: string
      patch: FloorPlanTrayWritePayload
    }) =>
      api<FloorPlanTray>(`/api/floor-plan-trays/${trayId}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidateTrays,
    onError: (err) => apiErrorToast(err),
  })
  const deleteTray = useMutation({
    mutationFn: (trayId: string) =>
      api<void>(`/api/floor-plan-trays/${trayId}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateTrays()
      setSelectedTrayId(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  const exportPng = async () => {
    if (!exportRef.current || !plan) return
    const url = await toPng(exportRef.current, {
      backgroundColor: theme === "dark" ? "#09090b" : "#ffffff",
      pixelRatio: 2,
    })
    const a = document.createElement("a")
    a.href = url
    a.download = `${plan.name}.png`
    a.click()
  }

  const openTile = (tile: FloorPlanTile) => {
    if (tile.linked?.kind === "floorplan") {
      nav({ to: "/floorplans/$id", params: { id: tile.linked.id } })
      return
    }
    // Rack/device tiles open the contents + end-to-end trace sheet.
    if (tile.linked?.kind === "rack" || tile.linked?.kind === "device") {
      setDeepTile(tile)
      return
    }
    setSelectedId(tile.id)
  }

  // From a device's paths in the deep-view: close the sheet and highlight one
  // cable, or a whole run (all its cables), on the plan — no Cables mode.
  const traceCablesOnMap = useCallback(
    (cableIds: string[]) => {
      setDeepTile(null)
      setShowLinksLocal(true)
      setHighlightCableIds(cableIds)
      const pts = cableIds
        .map((cid) => cablePaths.find((c) => c.id === cid))
        .filter((cp): cp is FloorPlanCablePath => !!cp)
        .flatMap((cp) => cableRoutePoints(cp, trays, tiles))
      if (pts.length >= 2)
        requestAnimationFrame(() => canvasApi.current?.focusPoints(pts))
      else if (cableIds.length)
        toast.info("That run isn't routed through a tray on this plan yet.")
    },
    [cablePaths, trays, tiles]
  )

  if (planQuery.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (planQuery.isError) return <QueryError error={planQuery.error} />
  if (!plan) return null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to="/floorplans">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{plan.name}</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {plan.site.name} · {plan.location.name} ·{" "}
            <span className="num">
              {plan.grid_width}×{plan.grid_height}
            </span>{" "}
            cells
          </p>
        </div>
        {isDirty && <Badge variant="secondary">unsaved</Badge>}
        {(floors.data?.results.length ?? 0) > 0 && (
          <div className="ml-4 flex min-w-0 items-center gap-1">
            <SegmentedTabs
              value={plan.id}
              onValueChange={(pid) => {
                if (pid === plan.id) return
                // Just navigate. Switching floors re-mounts the editor and drops
                // unsaved edits, but that is the leave guard's call to make —
                // confirming here too would stack a second dialog on the same
                // click.
                nav({ to: "/floorplans/$id", params: { id: pid } })
              }}
              items={(floors.data?.results ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="h-8 px-1.5"
                title="Add a floor to this location"
              >
                <Link
                  to="/floorplans/new"
                  search={{ location: plan.location.id }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SegmentedTabs<"2d" | "3d">
            value={view3d ? "3d" : "2d"}
            onValueChange={(v) =>
              nav({
                to: "/floorplans/$id",
                params: { id: plan.id },
                search: (prev) => ({
                  ...prev,
                  viz: v === "3d" ? ("3d" as const) : undefined,
                }),
                replace: true,
              })
            }
            items={[
              { value: "2d", label: "2D" },
              { value: "3d", label: "3D" },
            ]}
          />
          {canEdit && !view3d && (
            <SegmentedTabs<"layout" | "cable" | "structure">
              value={mode}
              onValueChange={(m) => {
                setMode(m)
                setSelectedId(null)
                setSelectedTrayId(null)
                setArmed(null)
                setDrawPoints(null)
                setSelectedAreaId(null)
                setAreaArmed(false)
                setMultiSel(new Set())
                // Leaving Cables mode must exit tray-edit — otherwise Layout
                // mode stays frozen (tiles unselectable, cables hidden).
                setTrayEditMode(false)
              }}
              items={[
                { value: "layout", label: "Layout" },
                { value: "structure", label: "Structure" },
                { value: "cable", label: "Cables" },
              ]}
            />
          )}
          {mode === "layout" && (
            <TileSearch
              tiles={tiles}
              value={search}
              onChange={setSearch}
              onPick={(tile) => {
                setSelectedId(tile.id)
                canvasApi.current?.focusTile(tile)
              }}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            title="Fit to view"
            onClick={() => canvasApi.current?.fit()}
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowGrid((g) => !g)}
            className={cn(!showGrid && "text-muted-foreground")}
          >
            <Grid3x3 className="h-3.5 w-3.5" /> Grid
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setViewPref("show_objects", !showObjects)}
            className={cn(!showObjects && "text-muted-foreground")}
            title="List the objects placed on this plan"
          >
            <PanelRight className="h-3.5 w-3.5" /> Objects
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="h-3.5 w-3.5" /> View
              </Button>
            </PopoverTrigger>
            {/* Two columns once the 3D block is in play. As one 224px stack
                this ran past the bottom of a laptop viewport and had to be
                scrolled inside; side by side it fits on screen. */}
            <PopoverContent
              align="end"
              collisionPadding={12}
              className={cn(
                "gap-1 p-2",
                view3d ? "grid w-[30rem] grid-cols-2 gap-x-3" : "w-56"
              )}
            >
              <div className="grid content-start gap-1">
                <FormCheckbox
                  label="Fit labels to tiles"
                  checked={labelFit}
                  onChange={(v) => setViewPref("label_fit", v)}
                  className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                />
                <FormCheckbox
                  label="Camera FOV cones"
                  checked={showFov}
                  onChange={(v) => setViewPref("show_fov", v)}
                  className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                />
                <FormCheckbox
                  label="Zone labels"
                  checked={showZoneLabels}
                  onChange={(v) => setViewPref("show_zone_labels", v)}
                  className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                />
                <div className="my-1 h-px bg-border" />
                <FormCheckbox
                  label="Cable trays"
                  checked={showTrays}
                  onChange={(v) => setViewPref("show_trays", v)}
                  className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                />
                <FormCheckbox
                  label="Cable links (A↔B)"
                  checked={showCableLinks}
                  onChange={(v) => setViewPref("show_cable_links", v)}
                  className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                />
              </div>
              {view3d && (
                <div className="grid content-start gap-1 border-l border-border pl-3">
                  <span className="px-2 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                    3D · shown up close
                  </span>
                  <FormCheckbox
                    label="U numbers"
                    checked={show3dU}
                    onChange={(v) => setViewPref("show_3d_u", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <FormCheckbox
                    label="Device names"
                    checked={show3dNames}
                    onChange={(v) => setViewPref("show_3d_names", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <FormCheckbox
                    label="Cables"
                    checked={show3dCables}
                    onChange={(v) => setViewPref("show_3d_cables", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <FormCheckbox
                    label="Airflow"
                    checked={show3dAirflow}
                    onChange={(v) => setViewPref("show_3d_airflow", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <FormCheckbox
                    label="Lift raised floor"
                    checked={floorPeek}
                    onChange={(v) => setViewPref("show_3d_floor_peek", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <FormCheckbox
                    label="Walls"
                    checked={show3dWalls}
                    onChange={(v) => setViewPref("show_3d_walls", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <FormCheckbox
                    label="Ceiling"
                    checked={show3dCeiling}
                    onChange={(v) => setViewPref("show_3d_ceiling", v)}
                    className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  />
                  <div className="px-2 pt-1.5 pb-1">
                    <span className="mb-1 block text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                      Cabinet shell
                    </span>
                    <SegmentedTabs<ShellMode3D>
                      value={shell3d}
                      onValueChange={setShellMode}
                      items={[
                        { value: "solid", label: "Solid" },
                        { value: "cutaway", label: "Cutaway" },
                        { value: "xray", label: "X-ray" },
                      ]}
                    />
                  </div>
                  <div className="px-2 pt-1.5 pb-1">
                    <span className="mb-1 block text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                      Quality — this device
                    </span>
                    <SegmentedTabs<RenderQualitySetting>
                      value={quality3d}
                      onValueChange={setQuality3d}
                      items={[
                        { value: "auto", label: "Auto" },
                        { value: "flat", label: "Flat" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Med" },
                        { value: "high", label: "High" },
                      ]}
                    />
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                      Shadows and ambient occlusion. Flat turns the light rig
                      off entirely. Saved per device, not on the plan — Auto
                      probes the GPU.
                    </p>
                  </div>
                </div>
              )}
            </PopoverContent>
          </Popover>
          {canEdit && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <ImageIcon className="h-3.5 w-3.5" /> Background
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 gap-3 p-3">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) uploadBackground.mutate(f)
                    e.target.value = ""
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploadBackground.isPending}
                    onClick={() => fileInput.current?.click()}
                  >
                    {plan.background_image ? "Replace image…" : "Upload image…"}
                  </Button>
                  {plan.background_image && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={uploadBackground.isPending}
                      onClick={() => uploadBackground.mutate(null)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {plan.background_image && (
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">
                      Opacity —{" "}
                      <span className="num">{plan.background_opacity}%</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      defaultValue={plan.background_opacity}
                      onMouseUp={(e) =>
                        patchPlan.mutate({
                          background_opacity: Number(
                            (e.target as HTMLInputElement).value
                          ),
                        })
                      }
                      onTouchEnd={(e) =>
                        patchPlan.mutate({
                          background_opacity: Number(
                            (e.target as HTMLInputElement).value
                          ),
                        })
                      }
                    />
                  </label>
                )}
              </PopoverContent>
            </Popover>
          )}
          <Button variant="outline" size="sm" onClick={exportPng}>
            <Download className="h-3.5 w-3.5" /> PNG
          </Button>
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {canEdit && (
            <Button
              size="sm"
              disabled={!isDirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </header>

      {/* ── Body: palette rail · canvas · inspector ─────────────────── */}
      <div className="flex min-h-0 flex-1">
        {canEdit && mode === "cable" && (
          <TrayRail
            trays={trays}
            selectedTrayId={selectedTrayId}
            drawing={drawPoints !== null}
            editMode={trayEditMode}
            onToggleEdit={() => setTrayEditMode((v) => !v)}
            onSelectTray={setSelectedTrayId}
            onStartDraw={() => {
              setSelectedTrayId(null)
              setTrayEditMode(false)
              setDrawPoints([])
            }}
            onCancelDraw={() => setDrawPoints(null)}
          />
        )}
        {canEdit && mode === "structure" && (
          <StructureRail
            areas={areas}
            selectedAreaId={selectedAreaId}
            drawing={areaArmed}
            onSelectArea={(aid) => {
              setSelectedAreaId(aid)
              if (aid) setSelectedWallId(null)
            }}
            onStartDraw={() => {
              setSelectedAreaId(null)
              setSelectedWallId(null)
              setDrawPoints(null)
              setDoorArmed(false)
              setAreaArmed(true)
            }}
            onCancelDraw={() => setAreaArmed(false)}
            walls={walls}
            selectedWallId={selectedWallId}
            wallDrawing={drawPoints !== null}
            onSelectWall={(wid) => {
              setSelectedWallId(wid)
              if (wid) setSelectedAreaId(null)
            }}
            onStartWallDraw={() => {
              setSelectedWallId(null)
              setSelectedAreaId(null)
              setAreaArmed(false)
              setDoorArmed(false)
              setDrawPoints([])
            }}
            onCancelWallDraw={() => setDrawPoints(null)}
          />
        )}
        {canEdit && mode === "layout" && (
          <aside className="flex w-56 shrink-0 flex-col border-r border-border">
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Palette
              </span>
              <Button variant="ghost" size="sm" asChild className="h-6 px-1.5">
                <Link
                  to="/floor-tile-types/new"
                  search={{ from: plan.id }}
                  title="Add tile type"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
            <div className="px-2 pb-1">
              <SegmentedTabs<"tiles" | "zones">
                value={paletteTab}
                onValueChange={setPaletteTab}
                items={[
                  {
                    value: "tiles",
                    label: "Tiles",
                    count: palette.filter((p) => !p.isZone).length || null,
                  },
                  {
                    value: "zones",
                    label: "Background",
                    count: palette.filter((p) => p.isZone).length || null,
                  },
                ]}
              />
            </div>
            <div className="flex-1 space-y-0.5 overflow-y-auto p-2 pt-1">
              {paletteTab === "tiles" && shownPalette.length === 0 && (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  No tile types yet. Create “Rack”, “Wall”, “Cooling”… under{" "}
                  <Link to="/floor-tile-types" className="underline">
                    Customize → Floor tiles
                  </Link>
                  ; device roles show up here automatically.
                </p>
              )}
              {paletteTab === "zones" && shownPalette.length === 0 && (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  No background tiles yet. Create a tile type with the
                  “Background zone” tick — a red “Hot aisle”, a blue “Cold
                  aisle”, a security area — and paint it under your tiles.
                </p>
              )}
              {shownPalette.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() =>
                    setArmed((cur) => (cur?.key === entry.key ? null : entry))
                  }
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
                    armed?.key === entry.key &&
                      "bg-muted ring-1 ring-foreground/20"
                  )}
                >
                  <TileBadge color={entry.color} icon={entry.icon} />
                  <span className="truncate">{entry.name}</span>
                  {(entry.kind === "role" || entry.hasFov) && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {entry.kind === "role" ? "role" : "cam"}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {armed && (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                {armed.isZone
                  ? `Drag across the area to paint ${armed.name} under your tiles. Esc to stop.`
                  : `Click a cell to place a ${armed.name}; drag to paint a run. Esc to stop.`}
              </p>
            )}
          </aside>
        )}

        <div className="relative min-w-0 flex-1">
          {tilesQuery.isError && (
            <div className="p-4">
              <QueryError error={tilesQuery.error} />
            </div>
          )}
          {view3d && (
            <>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading 3D view…
                  </div>
                }
              >
                <FloorScene3D
                  planId={plan.id}
                  liveState={liveState.data ?? null}
                  traceCableId={traceParam ?? null}
                  showUNumbers={show3dU}
                  showNames={show3dNames}
                  showCables={show3dCables}
                  showAirflow={show3dAirflow}
                  floorPeek={floorPeek}
                  showWalls={show3dWalls}
                  showCeiling={show3dCeiling}
                  shellMode={shell3d}
                  quality={quality3d}
                />
              </Suspense>
              {show3dHint && (
                <div className="absolute right-3 bottom-3 flex items-center gap-2 rounded-md border border-border bg-popover/90 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow backdrop-blur">
                  Drag to orbit · scroll to zoom · right-drag to pan · arrows /
                  WASD move · Space/C up-down · Shift sprint · F focus · click a
                  rack
                  <button
                    onClick={() => setShow3dHint(false)}
                    aria-label="Dismiss"
                    className="hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </>
          )}
          {!view3d && (
            <>
              <FloorCanvas
                plan={plan}
                tiles={tiles}
                selectedId={selectedId}
                editable={canEdit}
                showGrid={showGrid}
                armed={
                  mode === "structure"
                    ? areaArmed
                      ? AREA_PSEUDO_ENTRY
                      : null
                    : armed
                }
                onSelect={(id) => {
                  setSelectedId(id)
                  // A plain click always collapses the multi-selection — it
                  // means "work with THIS one now".
                  setMultiSel((prev) => (prev.size ? new Set() : prev))
                  // Clicking a tile pins its popover (the pointer is already over
                  // it, so the hook has the anchor point); clicking the background
                  // dismisses.
                  if (!id || !popover.pinCurrent()) popover.close()
                }}
                multiSelectedIds={multiSel}
                onToggleSelect={(tid) => {
                  setMultiSel((prev) => {
                    const next = new Set(prev)
                    if (next.has(tid)) next.delete(tid)
                    else next.add(tid)
                    // Exactly one tile selected → open the full inspector
                    // (Linked object, facing, label…); the bulk bar alone
                    // is a dead end for per-tile work like linking.
                    setSelectedId(next.size === 1 ? [...next][0] : null)
                    return next
                  })
                }}
                onMarquee={(rect) => {
                  // Non-zone tiles intersecting the sweep join the selection.
                  const hit = tiles.filter(
                    (t) =>
                      !tileIsZone(t) &&
                      t.x < rect.x + rect.w &&
                      rect.x < t.x + t.width &&
                      t.y < rect.y + rect.h &&
                      rect.y < t.y + t.height
                  )
                  if (hit.length) {
                    setSelectedId(null)
                    setMultiSel(new Set(hit.map((t) => t.id)))
                  }
                }}
                onHoverTile={popover.onHover}
                onChangeTile={changeTileGuarded}
                onCreateRect={mode === "structure" ? createAreaAt : createAt}
                raisedFloors={areas}
                selectedAreaId={selectedAreaId}
                onSelectArea={setSelectedAreaId}
                onAreaRectChange={(areaId, rect) =>
                  patchArea.mutate({ areaId, body: rect })
                }
                walls={walls}
                selectedWallId={selectedWallId}
                onSelectWall={setSelectedWallId}
                onMoveWall={(wallId, points) =>
                  patchWall.mutate({ wallId, body: { points } })
                }
                doorArmed={doorArmed}
                onPlaceDoor={placeDoor}
                onOpenTile={openTile}
                exportRef={exportRef}
                liveState={liveState.data ?? null}
                labelFit={labelFit}
                showFov={showFov}
                showZoneLabels={showZoneLabels}
                mode={mode}
                trays={trays}
                showTrays={showTrays}
                selectedTrayId={selectedTrayId}
                onSelectTray={setSelectedTrayId}
                drawPoints={drawPoints ?? undefined}
                onAddDrawPoint={addDrawPoint}
                onFinishDraw={finishDraw}
                onMoveTray={(trayId, points) =>
                  patchTray.mutate({ trayId, patch: { points } })
                }
                trayEditMode={trayEditMode}
                cablePaths={cablePaths}
                showCableLinks={showCableLinks}
                highlightCableIds={highlightCableIds}
                onSelectCable={(cid) => setHighlightCableIds(cid ? [cid] : [])}
                onHighlightCables={(ids) => {
                  setHighlightCableIds(ids)
                  if (ids.length && !showCableLinks)
                    setViewPref("show_cable_links", true)
                }}
                apiRef={canvasApi}
              />
              {canEdit && mode === "layout" && multiSel.size > 0 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
                  <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
                    <span className="num pl-1 text-xs font-medium">
                      {multiSel.size} selected
                    </span>
                    <span className="h-4 w-px bg-border" />
                    <span className="text-[11px] text-muted-foreground">
                      Front faces
                    </span>
                    {(
                      [
                        { o: 0 as const, icon: ArrowUp, label: "up" },
                        { o: 90 as const, icon: ArrowRight, label: "right" },
                        { o: 180 as const, icon: ArrowDown, label: "down" },
                        { o: 270 as const, icon: ArrowLeft, label: "left" },
                      ] as const
                    ).map(({ o, icon: Icon, label }) => (
                      <Button
                        key={o}
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        title={`Front faces ${label}`}
                        aria-label={`Front faces ${label}`}
                        onClick={() => {
                          // Per-tile absolute facing — setTileFacing keeps the
                          // footprint-swap + collision rules a hand rotate has.
                          for (const tid of multiSel) {
                            const t = tiles.find((x) => x.id === tid)
                            if (t) setTileFacing(t, o)
                          }
                        }}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </Button>
                    ))}
                    <span className="h-4 w-px bg-border" />
                    <Select
                      value=""
                      onValueChange={(key) => {
                        // "tt:<id>" | "role:<id>" — the palette's own keys.
                        const [kind, tid] = key.split(":")
                        if (kind === "tt") {
                          const row = tileTypes.data?.results.find(
                            (r) => r.id === tid
                          )
                          if (!row) return
                          for (const sel of multiSel)
                            changeTile(sel, {
                              tile_type: row,
                              role_type: null,
                            })
                        } else {
                          const row = roles.data?.results.find(
                            (r) => r.id === tid
                          )
                          if (!row) return
                          for (const sel of multiSel)
                            changeTile(sel, {
                              tile_type: null,
                              role_type: row,
                            })
                        }
                      }}
                    >
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue placeholder="Set type…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(tileTypes.data?.results ?? [])
                          .filter((tt) => !tt.is_zone)
                          .map((tt) => (
                            <SelectItem key={tt.id} value={`tt:${tt.id}`}>
                              {tt.name}
                            </SelectItem>
                          ))}
                        {(roles.data?.results ?? []).map((r) => (
                          <SelectItem key={r.id} value={`role:${r.id}`}>
                            {r.name} (role)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="h-4 w-px bg-border" />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => {
                        for (const tid of multiSel) deleteTile(tid)
                        setMultiSel(new Set())
                      }}
                    >
                      <Trash2 className="mr-1 h-3 w-3" /> Delete
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => setMultiSel(new Set())}
                      title="Clear selection"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
              {mode === "cable" && drawPoints !== null && (
                <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
                  Click corners to route the tray · double-click to finish · Esc
                  to cancel ({drawPoints.length})
                </div>
              )}
              {mode === "structure" && drawPoints !== null && (
                <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
                  Click corners to run the wall · double-click to finish · Esc
                  to cancel ({drawPoints.length})
                </div>
              )}
              {doorArmed && (
                <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
                  Click a wall to place a 900 mm door · Esc to cancel
                </div>
              )}
              {trayEditMode && (
                <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
                  <span>
                    <span className="font-medium">Editing trays</span> — cables
                    hidden. Click a tray, drag its points, click{" "}
                    <span className="font-medium">＋</span> to add a bend,
                    right-click a point to remove.
                  </span>
                  <Button
                    size="sm"
                    className="h-6 px-2"
                    onClick={() => setTrayEditMode(false)}
                  >
                    Done
                  </Button>
                </div>
              )}
              {/* Replaces the SVG <title> the browser used to draw: anchored to the
              tile, styled, links out, and pinnable so it can actually be read. */}
              <TilePopover
                target={popover.target}
                live={
                  popover.target
                    ? liveState.data?.tiles[popover.target.tile.id]
                    : undefined
                }
                fields={popoverFields}
                onOpenChange={(open) => !open && popover.close()}
                renderLinked={(tile) =>
                  tile.linked ? <LinkedObjectLink linked={tile.linked} /> : null
                }
                renderActions={(tile) =>
                  tile.linked?.kind === "rack" ||
                  tile.linked?.kind === "device" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full"
                      onClick={() => {
                        popover.close()
                        setDeepTile(tile)
                      }}
                    >
                      {tile.linked.kind === "rack" ? (
                        <PanelRight className="h-3.5 w-3.5" />
                      ) : (
                        <Waypoints className="h-3.5 w-3.5" />
                      )}
                      {tile.linked.kind === "rack"
                        ? "Contents & trace"
                        : "Trace"}
                    </Button>
                  ) : null
                }
              />
            </>
          )}
        </div>

        {canEdit && mode === "layout" && selected && (
          <TileInspector
            key={selected.id}
            tile={selected}
            planId={plan.id}
            onChange={(patch) => changeTile(selected.id, patch)}
            onRotate={() => rotateTile(selected)}
            onSetFacing={(o) => setTileFacing(selected, o)}
            onDelete={() => deleteTile(selected.id)}
            onOpenContents={
              selected.linked?.kind === "rack" ||
              selected.linked?.kind === "device"
                ? () => setDeepTile(selected)
                : undefined
            }
          />
        )}
        {canEdit && mode === "cable" && selectedTray && (
          <TrayInspector
            key={selectedTray.id}
            highlightCableId={highlightCableIds[0] ?? null}
            tray={selectedTray}
            editing={trayEditMode}
            onEditShape={() => setTrayEditMode((v) => !v)}
            onHighlightCable={(cableId) => {
              setHighlightCableIds(cableId ? [cableId] : [])
              if (cableId && !showCableLinks)
                setViewPref("show_cable_links", true)
            }}
            onPatch={(patch) =>
              patchTray.mutate({ trayId: selectedTray.id, patch })
            }
            onDelete={() => deleteTray.mutate(selectedTray.id)}
          />
        )}
        {canEdit &&
          mode === "structure" &&
          (() => {
            const wall = walls.find((w) => w.id === selectedWallId)
            if (wall)
              return (
                <WallInspector
                  key={wall.id}
                  wall={wall}
                  cellMM={plan.cell_mm}
                  ceilingMM={plan.ceiling_mm}
                  doorArmed={doorArmed}
                  onArmDoor={() => setDoorArmed((v) => !v)}
                  onPatch={(body) =>
                    patchWall.mutate({ wallId: wall.id, body })
                  }
                  onDelete={() => deleteWall.mutate(wall.id)}
                />
              )
            const area = areas.find((a) => a.id === selectedAreaId)
            if (!area) return null
            return (
              <AreaInspector
                key={area.id}
                area={area}
                onPatch={(body) => patchArea.mutate({ areaId: area.id, body })}
                onDelete={() => deleteArea.mutate(area.id)}
              />
            )
          })()}
        {/* Outermost right aside, so it coexists with whichever inspector is
            open rather than fighting it for the gutter. */}
        {showObjects && (
          <ObjectsSidebar
            tiles={tiles}
            liveState={liveState.data ?? null}
            selectedId={selectedId}
            onPick={(tile) => {
              setSelectedId(tile.id)
              canvasApi.current?.focusTile(tile)
            }}
          />
        )}
      </div>

      <TrayNameDialog
        points={namingPoints}
        onCancel={() => setNamingPoints(null)}
        onCreate={(payload) => {
          createTray.mutate(payload)
          setNamingPoints(null)
        }}
      />

      <DeepViewSheet
        tile={deepTile}
        onClose={() => setDeepTile(null)}
        onTraceCables={traceCablesOnMap}
      />

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Floor plan settings</DialogTitle>
          </DialogHeader>
          <FloorPlanForm
            plan={plan}
            onSaved={() => setSettingsOpen(false)}
            onCancel={() => setSettingsOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* The leave guard's one dialog — for a floor switch, a sidebar link, and
          browser back alike. The router holds the navigation open until this
          resolves, so every close path must settle it: leave the blocker
          hanging and the next navigation is stuck behind it forever. */}
      <AlertDialog
        open={leaveGuard.status === "blocked"}
        onOpenChange={(open) => {
          // Escape, an overlay click, and "Keep editing" all mean stay.
          if (!open) leaveGuard.reset?.()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This plan has unsaved changes. Leaving this page — including
              switching to another floor — drops them. Save first to keep them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            {/* Radix closes on action too, so onOpenChange's reset() lands right
                after this proceed(). Both settle the same promise and only the
                first wins, so the navigation still goes through. */}
            <AlertDialogAction
              variant="destructive"
              onClick={() => leaveGuard.proceed?.()}
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Client-side Link per link kind — plain <a href> would full-reload the SPA. */
function LinkedObjectLink({
  linked,
}: {
  linked: NonNullable<FloorPlanTile["linked"]>
}) {
  const label = (
    <>
      <ExternalLink className="h-3 w-3" />
      Open {linked.kind === "floorplan" ? "plan" : linked.kind} {linked.name}
    </>
  )
  const className =
    "mt-2 inline-flex items-center gap-1.5 text-xs underline-offset-2 hover:underline"
  const params = { id: linked.id }
  switch (linked.kind) {
    case "rack":
      return (
        <Link to="/racks/$id" params={params} className={className}>
          {label}
        </Link>
      )
    case "device":
      return (
        <Link to="/devices/$id" params={params} className={className}>
          {label}
        </Link>
      )
    case "powerpanel":
      return (
        <Link to="/power-panels/$id/edit" params={params} className={className}>
          {label}
        </Link>
      )
    case "powerfeed":
      return (
        <Link to="/power-feeds/$id/edit" params={params} className={className}>
          {label}
        </Link>
      )
    case "floorplan":
      return (
        <Link to="/floorplans/$id" params={params} className={className}>
          {label}
        </Link>
      )
  }
}

/** A labelled FOV slider with a live value readout.
 *
 * The value sits beside the label rather than in a box: you're dragging against
 * the cone drawn on the plan, so the number is feedback, not an input. */
function FovSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="num text-[12px] font-medium">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        className="mt-1.5"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        aria-label={label}
      />
    </div>
  )
}

/** Editor inspector — label / color / status / rotate / link / delete. */
function TileInspector({
  tile,
  planId,
  onChange,
  onRotate,
  onSetFacing,
  onDelete,
  onOpenContents,
}: {
  tile: FloorPlanTile
  planId: string
  onChange: (patch: Partial<FloorPlanTile>) => void
  onRotate: () => void
  onSetFacing: (o: 0 | 90 | 180 | 270) => void
  onDelete: () => void
  onOpenContents?: () => void
}) {
  const linkKind = tile.linked?.kind ?? null
  const setLink = (kind: FloorPlanLinkKind | null, id: string | null) => {
    if (!kind || !id) {
      onChange({ link_kind: "", linked: null })
      return
    }
    onChange({
      link_kind: kind,
      linked: {
        kind,
        id,
        name: tile.linked?.id === id ? tile.linked.name : "",
        route: "",
      },
    })
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Tile
        </span>
        <span className="num text-[11px] text-muted-foreground">
          ({tile.x},{tile.y}) · {tile.width}×{tile.height}
        </span>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded"
          style={{
            backgroundColor: `${tileFill(tile)}33`,
            color: tileFill(tile),
          }}
        >
          {tile.tile_type?.icon ? (
            <DynamicIcon name={tile.tile_type.icon} className="h-3.5 w-3.5" />
          ) : (
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: tileFill(tile) }}
            />
          )}
        </span>
        <span className="font-medium">
          {tile.tile_type?.name ?? tile.role_type?.name}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 px-2"
          onClick={onRotate}
          title="Rotate 90° (swaps footprint, spins the icon)"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Facing is the TILE's own property — build-in-advance tiles need it
          set before any rack is linked, so only zones (no front) skip it. */}
      {!tileIsZone(tile) && (
        <Field label="Front faces" hint="Marked on the tile's front edge">
          <div className="grid grid-cols-4 gap-1">
            {(
              [
                { o: 0 as const, icon: ArrowUp, label: "Up" },
                { o: 90 as const, icon: ArrowRight, label: "Right" },
                { o: 180 as const, icon: ArrowDown, label: "Down" },
                { o: 270 as const, icon: ArrowLeft, label: "Left" },
              ] as const
            ).map(({ o, icon: Icon, label }) => (
              <Button
                key={o}
                variant={tile.orientation === o ? "secondary" : "outline"}
                size="sm"
                className={cn(
                  "h-8 px-0",
                  tile.orientation === o && "border-primary/50"
                )}
                onClick={() => onSetFacing(o)}
                title={`Front faces ${label.toLowerCase()}`}
                aria-label={`Front faces ${label.toLowerCase()}`}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            ))}
          </div>
        </Field>
      )}

      <Field label="Label" hint="Overrides the linked object's name">
        <Input
          value={tile.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={tile.linked?.name || "Optional"}
          className="h-8 text-sm"
        />
      </Field>

      <Field label="Color" hint="Overrides the type color">
        <ColorPicker
          value={tile.color}
          onChange={(color) => onChange({ color })}
        />
      </Field>

      <FormSelect
        label="Status"
        value={tile.status || null}
        onChange={(v) => onChange({ status: (v ?? "") as FloorTileStatus })}
        options={STATUS_OPTIONS}
        noneLabel="—"
        placeholder="—"
      />

      {tileHasFov(tile) && (
        <div className="grid gap-2">
          <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Field of view
          </span>
          <FormCheckbox
            label={
              <>
                PTZ <span className="text-muted-foreground">— 360° ring</span>
              </>
            }
            checked={tile.fov_ptz}
            onChange={(v) => onChange({ fov_ptz: v })}
            className="items-center text-[13px]"
          />
          {/* Sliders, not number boxes: these are all continuous physical
              quantities you tune against the cone drawn on the plan, so dragging
              with live feedback beats typing a number and re-reading the canvas. */}
          <div className="grid gap-3">
            {!tile.fov_ptz && (
              <FovSlider
                label="Direction"
                value={tile.fov_direction ?? 0}
                min={0}
                max={359}
                unit="°"
                onChange={(v) => onChange({ fov_direction: v })}
              />
            )}
            {!tile.fov_ptz && (
              <FovSlider
                label="Angle"
                value={tile.fov_deg ?? 90}
                min={10}
                max={360}
                step={5}
                unit="°"
                onChange={(v) => onChange({ fov_deg: v })}
              />
            )}
            <FovSlider
              label="Reach"
              value={tile.fov_distance ?? 3}
              min={1}
              max={50}
              unit=" cells"
              onChange={(v) => onChange({ fov_distance: v })}
            />
          </div>
          <Field label="Emits from" hint="Click a dot">
            <FovAnchorDice
              value={tile.fov_anchor}
              onChange={(a) => onChange({ fov_anchor: a })}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-2">
        <FormSelect
          label="Linked object"
          hint="Drives overlays + deep links"
          value={linkKind}
          onChange={(v) => {
            if (!v) setLink(null, null)
            else if (v !== linkKind)
              onChange({
                link_kind: v as FloorPlanLinkKind,
                linked: null,
              })
          }}
          options={LINK_KIND_OPTIONS}
          noneLabel="Not linked"
          placeholder="Not linked"
        />
        <LinkTargetPicker
          kind={tile.link_kind || null}
          value={tile.linked?.id ?? null}
          planId={planId}
          roleId={tile.role_type?.id ?? null}
          onPick={(id) => setLink(tile.link_kind || null, id)}
        />
      </div>

      <div className="mt-auto grid gap-2 border-t border-border pt-3">
        {onOpenContents && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onOpenContents}
          >
            {tile.linked?.kind === "rack" ? (
              <PanelRight className="h-3.5 w-3.5" />
            ) : (
              <Waypoints className="h-3.5 w-3.5" />
            )}
            {tile.linked?.kind === "rack" ? "Contents & trace" : "Trace"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove tile
        </Button>
      </div>
    </aside>
  )
}

function LinkTargetPicker({
  kind,
  value,
  planId,
  roleId,
  onPick,
}: {
  kind: FloorPlanLinkKind | null
  value: string | null
  planId: string
  /** The tile's device role (role tiles) — devices with it sort first in the
   * picker, and the advanced dialog opens pre-filtered to it. */
  roleId?: string | null
  onPick: (id: string | null) => void
}) {
  const panels = useQuery({
    queryKey: ["power-panels-picker"],
    queryFn: () =>
      api<Paginated<PowerPanelOption>>("/api/power-panels/?picker=1"),
    enabled: kind === "powerpanel",
  })
  const feeds = useQuery({
    queryKey: ["power-feeds-picker"],
    queryFn: () =>
      api<
        Paginated<{ id: string; name: string; power_panel: PowerPanelOption }>
      >("/api/power-feeds/"),
    enabled: kind === "powerfeed",
  })
  const plans = useQuery({
    queryKey: ["floor-plans-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/floor-plans/?picker=1"
      ),
    enabled: kind === "floorplan",
  })

  if (!kind) return null
  if (kind === "rack")
    return <RackPicker label="Rack" value={value} onChange={onPick} />
  if (kind === "device")
    return (
      <DevicePicker
        label="Device"
        value={value}
        onChange={onPick}
        preferQuery={roleId ? `role=${roleId}` : undefined}
        initialFilters={roleId ? { role: roleId } : undefined}
      />
    )
  if (kind === "powerpanel")
    return (
      <FormCombobox
        label="Power panel"
        value={value}
        onChange={onPick}
        options={(panels.data?.results ?? []).map((p) => ({
          value: p.id,
          label: p.name,
        }))}
        placeholder="Select a panel…"
        searchPlaceholder="Search panels…"
        emptyText="No power panels."
      />
    )
  if (kind === "powerfeed")
    return (
      <FormCombobox
        label="Power feed"
        value={value}
        onChange={onPick}
        options={(feeds.data?.results ?? []).map((f) => ({
          value: f.id,
          label: `${f.name} (${f.power_panel.name})`,
        }))}
        placeholder="Select a feed…"
        searchPlaceholder="Search feeds…"
        emptyText="No power feeds."
      />
    )
  return (
    <FormCombobox
      label="Floor plan"
      value={value}
      onChange={onPick}
      options={(plans.data?.results ?? [])
        .filter((p) => p.id !== planId)
        .map((p) => ({ value: p.id, label: p.name }))}
      placeholder="Select a plan…"
      searchPlaceholder="Search plans…"
      emptyText="No other floor plans."
    />
  )
}

/** The contents + end-to-end trace sheet for a rack- or device-linked tile:
 * rack → capacity + the real elevation + its devices, each traceable;
 * device → its end-to-end paths (DeviceMiniTopology). */
function DeepViewSheet({
  tile,
  onClose,
  onTraceCables,
}: {
  tile: FloorPlanTile | null
  onClose: () => void
  onTraceCables: (cableIds: string[]) => void
}) {
  const linked = tile?.linked ?? null
  return (
    <Sheet open={!!linked} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        // The default sm:max-w-sm is keyed on data-[side=right], so the
        // override must use the same variant to win the merge.
        className="w-full overflow-y-auto data-[side=right]:sm:max-w-3xl"
      >
        {linked?.kind === "rack" && (
          <RackDeepView rackId={linked.id} onTraceCables={onTraceCables} />
        )}
        {linked?.kind === "device" && (
          <DeviceDeepView
            deviceId={linked.id}
            name={linked.name}
            onTraceCables={onTraceCables}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function RackDeepView({
  rackId,
  onTraceCables,
}: {
  rackId: string
  onTraceCables: (cableIds: string[]) => void
}) {
  const rackQ = useQuery({
    queryKey: ["rack", rackId],
    queryFn: () => api<Rack>(`/api/racks/${rackId}/`),
  })
  const devicesQ = useQuery({
    queryKey: ["rack-devices", rackId],
    queryFn: () =>
      api<Paginated<Device>>(`/api/devices/?rack=${rackId}&page_size=500`),
  })
  const [traceDevice, setTraceDevice] = useState<Device | null>(null)
  const [showElevation, setShowElevation] = useState(false)

  const rack = rackQ.data
  const devices = [...(devicesQ.data?.results ?? [])].sort(
    (a, b) => (b.position ?? -1) - (a.position ?? -1)
  )

  if (traceDevice)
    return (
      <div className="flex h-full flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 px-1.5"
              onClick={() => setTraceDevice(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            {traceDevice.name}
          </SheetTitle>
          <SheetDescription>
            End-to-end cable paths from this device.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 px-4 pb-4">
          <DeviceMiniTopology
            deviceId={traceDevice.id}
            onTraceCables={onTraceCables}
          />
        </div>
      </div>
    )

  const utilization =
    rack && rack.u_height > 0 ? rack.used_units / rack.u_height : null

  return (
    <div className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>{rack?.name ?? "Rack"}</SheetTitle>
        <SheetDescription>
          {rack && (
            <>
              <span className="num">
                {rack.used_units}/{rack.u_height}U used
              </span>
              {" · "}
              <span className="num">
                {rack.power.allocated_w}/{rack.power.available_w} W
              </span>
              {" · "}
              <span className="num">{rack.device_count}</span> device
              {rack.device_count === 1 ? "" : "s"}
            </>
          )}
        </SheetDescription>
      </SheetHeader>
      <div className="grid gap-4 px-4 pb-4">
        {rackQ.isError && <QueryError error={rackQ.error} />}
        {utilization !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.round(utilization * 100))}%`,
                backgroundColor: utilizationColor(utilization),
              }}
            />
          </div>
        )}
        {rack && (
          <Button variant="outline" size="sm" asChild className="w-fit">
            <Link to="/racks/$id" params={{ id: rack.id }}>
              <ExternalLink className="h-3.5 w-3.5" /> Open rack page
            </Link>
          </Button>
        )}
        {rack && (
          <div>
            <button
              type="button"
              onClick={() => setShowElevation((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  showElevation && "rotate-90"
                )}
              />
              Elevation
            </button>
            {showElevation && (
              <div className="mt-2">
                <RackElevation rack={rack} />
              </div>
            )}
          </div>
        )}
        <div>
          <p className="mb-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Devices
          </p>
          {devices.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing racked here yet.
            </p>
          )}
          <ul className="divide-y divide-border text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 py-1.5">
                <span className="num w-10 shrink-0 text-[11px] text-muted-foreground">
                  {d.position !== null ? `U${d.position}` : "—"}
                </span>
                <Link
                  to="/devices/$id"
                  params={{ id: d.id }}
                  className="min-w-0 truncate font-medium hover:underline"
                >
                  {d.name}
                </Link>
                {d.role && (
                  <span
                    className="rounded-sm px-1.5 py-0.5 text-[10px]"
                    style={{
                      backgroundColor: `${d.role.color || "#a1a1aa"}22`,
                      color: d.role.color || undefined,
                    }}
                  >
                    {d.role.name}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7"
                  title="Trace this device end-to-end"
                  aria-label={`Trace ${d.name}`}
                  onClick={() => setTraceDevice(d)}
                >
                  <Waypoints className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function DeviceDeepView({
  deviceId,
  name,
  onTraceCables,
}: {
  deviceId: string
  name: string
  onTraceCables: (cableIds: string[]) => void
}) {
  return (
    <div className="flex flex-col">
      <SheetHeader>
        <SheetTitle>{name || "Device"}</SheetTitle>
        <SheetDescription>
          End-to-end cable paths from this device. Trace a whole run, or the{" "}
          <Waypoints className="inline h-3 w-3" /> on one cable, on the plan.
        </SheetDescription>
      </SheetHeader>
      {/* Natural top-aligned stack — no flex-1 stretch, so the button sits
          right above the topology instead of leaving a tall gap. */}
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Button variant="outline" size="sm" asChild className="w-fit">
          <Link to="/devices/$id" params={{ id: deviceId }}>
            <ExternalLink className="h-3.5 w-3.5" /> Open device page
          </Link>
        </Button>
        <DeviceMiniTopology deviceId={deviceId} onTraceCables={onTraceCables} />
      </div>
    </div>
  )
}

/** Dice-5 anchor picker: five dots (corners + center) — click where the
 * FOV cone should emit from on the tile. */
function FovAnchorDice({
  value,
  onChange,
}: {
  value: FovAnchor
  onChange: (a: FovAnchor) => void
}) {
  const dots: { a: FovAnchor; cx: number; cy: number; label: string }[] = [
    { a: "tl", cx: 12, cy: 12, label: "Top left" },
    { a: "tr", cx: 44, cy: 12, label: "Top right" },
    { a: "", cx: 28, cy: 28, label: "Center" },
    { a: "bl", cx: 12, cy: 44, label: "Bottom left" },
    { a: "br", cx: 44, cy: 44, label: "Bottom right" },
  ]
  return (
    <svg
      width={56}
      height={56}
      className="rounded-md border border-border bg-muted/30"
      role="radiogroup"
      aria-label="Cone anchor"
    >
      {dots.map((d) => (
        <circle
          key={d.a || "center"}
          cx={d.cx}
          cy={d.cy}
          r={value === d.a ? 6 : 4}
          className={cn(
            "cursor-pointer transition-[r,fill]",
            value === d.a
              ? "fill-foreground"
              : "fill-muted-foreground/35 hover:fill-muted-foreground"
          )}
          role="radio"
          aria-checked={value === d.a}
          aria-label={d.label}
          onClick={() => onChange(d.a)}
        >
          <title>{d.label}</title>
        </circle>
      ))}
    </svg>
  )
}

/** Header search — jump to a tile by label / linked object / type name. */
function TileSearch({
  tiles,
  value,
  onChange,
  onPick,
}: {
  tiles: FloorPlanTile[]
  value: string
  onChange: (v: string) => void
  onPick: (tile: FloorPlanTile) => void
}) {
  const [open, setOpen] = useState(false)
  const q = value.trim().toLowerCase()
  const matches = q
    ? tiles
        .filter((t) => {
          const hay = [
            t.label,
            t.linked?.name,
            t.tile_type?.name,
            t.role_type?.name,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
          return hay.includes(q)
        })
        .slice(0, 8)
    : []
  return (
    <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Find on plan…"
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            className="h-8 w-48 pl-8 text-xs"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {matches.map((t) => {
          const label =
            tileName(t) || t.tile_type?.name || t.role_type?.name || "Tile"
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onPick(t)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted/60"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: tileFill(t) }}
              />
              <span className="truncate">{label}</span>
              {t.linked && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {t.linked.kind}
                </span>
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/** Structure-mode left rail — raised-floor areas + walls, each with its own
 * draw control. One rail, two catalogs: both are room construction. */
function StructureRail({
  areas,
  selectedAreaId,
  drawing,
  onSelectArea,
  onStartDraw,
  onCancelDraw,
  walls,
  selectedWallId,
  wallDrawing,
  onSelectWall,
  onStartWallDraw,
  onCancelWallDraw,
}: {
  areas: RaisedFloorArea[]
  selectedAreaId: string | null
  drawing: boolean
  onSelectArea: (id: string | null) => void
  onStartDraw: () => void
  onCancelDraw: () => void
  walls: FloorPlanWall[]
  selectedWallId: string | null
  wallDrawing: boolean
  onSelectWall: (id: string | null) => void
  onStartWallDraw: () => void
  onCancelWallDraw: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Raised floors
        </span>
      </div>
      <div className="px-3 pb-2">
        {drawing ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onCancelDraw}
            >
              Cancel drawing
            </Button>
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
              Drag a rectangle on the grid. Esc cancels.
            </p>
          </>
        ) : (
          <Button size="sm" className="w-full" onClick={onStartDraw}>
            Draw area
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {areas.length === 0 && !drawing && (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            No raised floors yet. Draw one — underfloor trays and cables will
            dive as deep as its plenum, and the 3D room shows the void.
          </p>
        )}
        {(areas.length > 0 || walls.length > 0) && (
          <p className="px-1.5 pb-1 text-[10px] leading-snug text-muted-foreground/80">
            Structure edits save immediately — the Save button governs tiles.
          </p>
        )}
        {areas.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelectArea(a.id === selectedAreaId ? null : a.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs hover:bg-muted/60",
              a.id === selectedAreaId && "bg-muted"
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-dashed"
              style={{ borderColor: a.color || "#71717a" }}
            />
            <span className="min-w-0 flex-1 truncate">
              {a.label || "Raised floor"}
            </span>
            <span className="num text-[10px] text-muted-foreground">
              {a.width}×{a.height} · {a.plenum_mm} mm
            </span>
          </button>
        ))}

        <div className="mt-2 flex items-center justify-between px-1.5 pt-2 pb-1">
          <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Walls
          </span>
        </div>
        <div className="px-1.5 pb-2">
          {wallDrawing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={onCancelWallDraw}
              >
                Cancel drawing
              </Button>
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                Click corners along the tile lattice (0.5-cell snap).
                Double-click or Enter finishes; Esc cancels.
              </p>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onStartWallDraw}
            >
              Draw wall
            </Button>
          )}
        </div>
        {walls.length === 0 && !wallDrawing && (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">
            No walls yet. Draw the room shell — the 3D view raises it; doors are
            added on a selected wall.
          </p>
        )}
        {walls.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => onSelectWall(w.id === selectedWallId ? null : w.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs hover:bg-muted/60",
              w.id === selectedWallId && "bg-muted"
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: w.color || "#52525b" }}
            />
            <span className="min-w-0 flex-1 truncate">{w.label || "Wall"}</span>
            <span className="num text-[10px] text-muted-foreground">
              {Math.max(0, w.points.length - 1)} seg
              {w.openings.length > 0
                ? ` · ${w.openings.length} door${w.openings.length === 1 ? "" : "s"}`
                : ""}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}

/** Structure-mode right panel: edit the selected wall — label, height, color,
 * and its doors (place by arm-and-click, tune or remove here). */
function WallInspector({
  wall,
  cellMM,
  ceilingMM,
  doorArmed,
  onArmDoor,
  onPatch,
  onDelete,
}: {
  wall: FloorPlanWall
  cellMM: number
  ceilingMM: number
  doorArmed: boolean
  onArmDoor: () => void
  onPatch: (body: Partial<FloorPlanWall>) => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(wall.label)
  const [height, setHeight] = useState(
    wall.height_mm == null ? "" : String(wall.height_mm)
  )
  const openings = wall.openings
  // Total run length (m) — the number a builder actually wants at a glance.
  const runM =
    wall.points.reduce((acc, p, i) => {
      if (i === 0) return 0
      const [px, py] = wall.points[i - 1]
      return acc + Math.hypot(p[0] - px, p[1] - py)
    }, 0) *
    (cellMM / 1000)

  const patchOpening = (idx: number, patch: Partial<FloorPlanWallOpening>) => {
    const next = openings.map((o, i) => (i === idx ? { ...o, ...patch } : o))
    onPatch({ openings: next })
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Wall
      </div>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Label</span>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== wall.label && onPatch({ label })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder="North wall"
          className="h-8"
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Height (mm)</span>
        <Input
          type="number"
          min={200}
          max={20000}
          value={height}
          onChange={(e) => setHeight(e.target.value)}
          onBlur={() => {
            const v = height.trim() === "" ? null : Number(height)
            if (v !== null && !Number.isFinite(v)) return
            if (v !== wall.height_mm) onPatch({ height_mm: v })
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder={`${ceilingMM} (ceiling)`}
          className="h-8"
        />
        <span className="text-[10px] text-muted-foreground">
          Blank = full height (the plan's ceiling).
        </span>
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Color</span>
        <ColorPicker
          value={wall.color}
          onChange={(color) => onPatch({ color })}
        />
      </div>

      <div className="grid gap-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Doors</span>
          <Button
            size="sm"
            variant={doorArmed ? "default" : "outline"}
            className="h-6 px-2"
            onClick={onArmDoor}
          >
            {doorArmed ? "Click the wall…" : "Add door"}
          </Button>
        </div>
        {openings.length === 0 && !doorArmed && (
          <p className="text-[11px] text-muted-foreground">
            No doors. Arm “Add door”, then click where the opening goes.
          </p>
        )}
        {openings.map((o, i) => {
          const widthMM = Math.round((o.to - o.from) * cellMM)
          return (
            <div
              key={i}
              className="grid gap-1.5 rounded-md border border-border p-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  Door {i + 1}
                  <span className="num ml-1 text-[10px] text-muted-foreground">
                    seg {o.seg + 1}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                  aria-label="Remove door"
                  onClick={() =>
                    onPatch({ openings: openings.filter((_, x) => x !== i) })
                  }
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Width (mm)
                  </span>
                  <Input
                    type="number"
                    min={100}
                    defaultValue={widthMM}
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isFinite(v) || v < 100 || v === widthMM)
                        return
                      // Grow/shrink about the door's centre, in cells.
                      const c = (o.from + o.to) / 2
                      const half = v / cellMM / 2
                      patchOpening(i, {
                        from: Math.max(0, Math.round((c - half) * 100) / 100),
                        to: Math.round((c + half) * 100) / 100,
                      })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur()
                    }}
                    className="h-7"
                  />
                </label>
                <label className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Height (mm)
                  </span>
                  <Input
                    type="number"
                    min={200}
                    defaultValue={o.height_mm ?? ""}
                    placeholder="2100"
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      const v = raw === "" ? null : Number(raw)
                      if (v !== null && !Number.isFinite(v)) return
                      if (v !== o.height_mm) patchOpening(i, { height_mm: v })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur()
                    }}
                    className="h-7"
                  />
                </label>
              </div>
            </div>
          )
        })}
      </div>

      <div className="num text-[11px] text-muted-foreground">
        {Math.max(0, wall.points.length - 1)} segment
        {wall.points.length - 1 === 1 ? "" : "s"} ·{" "}
        {runM.toFixed(1).replace(/\.0$/, "")} m run
      </div>
      <div className="mt-auto">
        <Button
          size="sm"
          variant="ghost"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete wall
        </Button>
      </div>
    </aside>
  )
}

/** Structure-mode right panel: edit the selected raised-floor area. */
function AreaInspector({
  area,
  onPatch,
  onDelete,
}: {
  area: RaisedFloorArea
  onPatch: (body: Partial<RaisedFloorArea>) => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(area.label)
  const [plenum, setPlenum] = useState(String(area.plenum_mm))
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Raised floor
      </div>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Label</span>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== area.label && onPatch({ label })}
          onKeyDown={(e) => {
            // Enter = commit, the key everyone presses in a text field.
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder="DC pad"
          className="h-8"
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Plenum depth (mm)</span>
        <Input
          type="number"
          min={50}
          max={2000}
          value={plenum}
          onChange={(e) => setPlenum(e.target.value)}
          onBlur={() => {
            const v = Number(plenum)
            if (Number.isFinite(v) && v !== area.plenum_mm)
              onPatch({ plenum_mm: v })
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          className="h-8"
        />
        <span className="text-[10px] text-muted-foreground">
          Underfloor trays and cable-length drops in this area use this depth.
        </span>
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Color</span>
        <ColorPicker
          value={area.color}
          onChange={(color) => onPatch({ color })}
        />
      </div>
      <div className="num text-[11px] text-muted-foreground">
        {area.width}×{area.height} cells at ({area.x}, {area.y})
      </div>
      <div className="mt-auto">
        <Button
          size="sm"
          variant="ghost"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete area
        </Button>
      </div>
    </aside>
  )
}

/** Cables-mode left rail — draw control, edit toggle + the tray list. */
function TrayRail({
  trays,
  selectedTrayId,
  drawing,
  editMode,
  onToggleEdit,
  onSelectTray,
  onStartDraw,
  onCancelDraw,
}: {
  trays: FloorPlanTray[]
  selectedTrayId: string | null
  drawing: boolean
  editMode: boolean
  onToggleEdit: () => void
  onSelectTray: (id: string | null) => void
  onStartDraw: () => void
  onCancelDraw: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cable trays
        </span>
        {drawing ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-destructive hover:text-destructive"
            onClick={onCancelDraw}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5"
            onClick={onStartDraw}
          >
            <Spline className="h-3.5 w-3.5" /> Draw
          </Button>
        )}
      </div>
      {!drawing && (
        <div className="px-2 pb-2">
          <Button
            variant={editMode ? "default" : "outline"}
            size="sm"
            className="w-full gap-1.5"
            onClick={onToggleEdit}
          >
            <Spline className="h-3.5 w-3.5" />
            {editMode ? "Done editing trays" : "Edit trays"}
          </Button>
          {editMode && (
            <p className="px-1 pt-1.5 text-[11px] text-muted-foreground">
              Cables hidden. Click a tray to reshape — drag points, ＋ to add a
              bend, right-click a point to remove.
            </p>
          )}
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2 pt-0">
        {trays.length === 0 && !drawing && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No trays yet. Click <span className="font-medium">Draw</span>, then
            click grid corners to route a tray a builder can follow. Assign the
            physical cables to it once it's drawn.
          </p>
        )}
        {trays.map((tray) => (
          <button
            key={tray.id}
            type="button"
            onClick={() => onSelectTray(tray.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
              tray.id === selectedTrayId && "bg-muted ring-1 ring-foreground/20"
            )}
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: tray.color || "#71717a" }}
            />
            <span className="truncate">{tray.name}</span>
            <span className="num ml-auto text-[10px] text-muted-foreground">
              {tray.cables.length}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}

/** Cables-mode right inspector — tray details + cable assignment. */
function TrayInspector({
  tray,
  highlightCableId,
  editing,
  onEditShape,
  onHighlightCable,
  onPatch,
  onDelete,
}: {
  tray: FloorPlanTray
  highlightCableId: string | null
  editing: boolean
  onEditShape: () => void
  onHighlightCable: (cableId: string | null) => void
  onPatch: (patch: FloorPlanTrayWritePayload) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(tray.name)
  const [kind, setKind] = useState(tray.kind)
  const [elevation, setElevation] = useState(
    tray.elevation_mm != null ? String(tray.elevation_mm) : ""
  )

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Tray
        </span>
        <span className="num text-[11px] text-muted-foreground">
          {tray.points.length} points
        </span>
      </div>

      <Button
        variant={editing ? "default" : "outline"}
        size="sm"
        className="w-full"
        onClick={onEditShape}
      >
        <Spline className="h-3.5 w-3.5" />
        {editing ? "Done editing shape" : "Edit shape (add bends, move)"}
      </Button>

      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== tray.name && onPatch({ name })}
          className="h-8 text-sm"
        />
      </Field>
      <Field label="Kind" hint="tray, conduit, ladder…">
        <Input
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          onBlur={() => kind !== tray.kind && onPatch({ kind })}
          placeholder="Optional"
          className="h-8 text-sm"
        />
      </Field>
      <Field label="Color">
        <ColorPicker
          value={tray.color}
          onChange={(color) => onPatch({ color })}
        />
      </Field>
      <Field label="Level" hint="Where the run physically lives">
        <Select
          value={tray.level}
          onValueChange={(v) => onPatch({ level: v as TrayLevel })}
        >
          <SelectTrigger size="sm" className="h-8 w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="overhead">Overhead</SelectItem>
            <SelectItem value="underfloor">Underfloor</SelectItem>
            <SelectItem value="floor">Floor level</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Elevation (mm)"
        hint="Height above floor — blank derives from the level"
      >
        <Input
          type="number"
          value={elevation}
          onChange={(e) => setElevation(e.target.value)}
          onBlur={() => {
            const v = elevation.trim() === "" ? null : Number(elevation)
            if (v !== tray.elevation_mm) onPatch({ elevation_mm: v })
          }}
          placeholder="Auto"
          className="h-8 text-sm"
        />
      </Field>

      <div className="grid gap-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cables in this tray
        </span>
        {tray.cables.length === 0 && (
          <p className="text-xs text-muted-foreground">None assigned yet.</p>
        )}
        <ul className="grid gap-1">
          {tray.cables.map((c) => (
            <li
              key={c.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[13px]",
                highlightCableId === c.id && "ring-1 ring-primary"
              )}
            >
              <button
                type="button"
                title="Show this cable's A↔B run"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() =>
                  onHighlightCable(highlightCableId === c.id ? null : c.id)
                }
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color || "#0ea5e9" }}
                />
                <span className="truncate font-mono text-xs">{c.label}</span>
                {c.type && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {c.type}
                  </span>
                )}
              </button>
              <button
                type="button"
                title="Remove"
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  onPatch({
                    cable_ids: tray.cables
                      .filter((x) => x.id !== c.id)
                      .map((x) => x.id),
                  })
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <CableAdd
          excludeIds={tray.cables.map((c) => c.id)}
          onAdd={(cableId) =>
            onPatch({ cable_ids: [...tray.cables.map((c) => c.id), cableId] })
          }
        />
      </div>

      <div className="mt-auto border-t border-border pt-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete tray
        </Button>
      </div>
    </aside>
  )
}

/** Name a freshly-drawn tray, then create it. */
function TrayNameDialog({
  points,
  onCancel,
  onCreate,
}: {
  points: [number, number][] | null
  onCancel: () => void
  onCreate: (payload: FloorPlanTrayWritePayload) => void
}) {
  const [name, setName] = useState("")
  const [kind, setKind] = useState("")
  const [color, setColor] = useState("#71717a")

  useEffect(() => {
    if (points) {
      setName("")
      setKind("")
      setColor("#71717a")
    }
  }, [points])

  return (
    <Dialog open={points !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Name this tray</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || !points) return
            onCreate({ name: name.trim(), kind, color, points })
          }}
        >
          <Field label="Name" hint="What the builder sees">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tray A · North corridor"
              className="h-9"
            />
          </Field>
          <Field label="Kind" hint="tray, conduit, ladder…">
            <Input
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="Optional"
              className="h-9"
            />
          </Field>
          <Field label="Color">
            <ColorPicker value={color} onChange={setColor} allowEmpty={false} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Create tray
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
