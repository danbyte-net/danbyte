import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Camera,
  Crosshair,
  Filter,
  LayoutGrid,
  Link2 as LinkIcon,
  PanelRight,
  Plus,
  Save,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { api, fetchTopology } from "@/lib/api"
import type {
  BulkStatusResponse,
  GhostEdgeData,
  Paginated,
  Status,
  TagOption,
  TopoEdge,
  TopoNode,
  TopologyGraph,
  TopologyQuery,
  TopologyViewSaved,
  TopologyViewState,
  TopologyViewSummary,
} from "@/lib/api"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Combobox } from "@/components/ui/combobox"
import { FormCheckbox } from "@/components/forms"
import { LevelOrganiser } from "@/components/topology/level-organiser"
import { CanvasLegend } from "@/components/topology/legend"
import { LogicalTopologyView } from "@/components/topology/logical-view"
import { TopologyObjectsSidebar } from "@/components/topology/map-sidebar"
import {
  NO_TOPO_HIDDEN,
  applyHidden,
  hiddenOnMap,
  readTopoHidden,
  type TopoHidden,
} from "@/components/topology/hidden"
import { StaleViewDialog } from "@/components/topology/stale-view-dialog"
import {
  docFromView,
  emptyDocument,
  isStaleViewError,
  readDefaultMap,
  storedDefaultMap,
  toViewState,
  useDocumentKeys,
  useMapLeaveGuard,
  useViewDocument,
} from "@/components/topology/view-document"
import type { ViewDocument } from "@/components/topology/view-document"
import { HiddenChip } from "@/components/hidden-chip"
import {
  setHidden as withHidden,
  useHideKeys,
} from "@/components/hidden-objects"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { DevicePicker } from "@/components/device-picker"
import { MaterializeCableDialog } from "@/components/topology/materialize-cable-dialog"
import {
  typeColor,
  type BundleMember,
  type CanvasHandle,
  type EdgeColorMode,
  type NodeStyle,
} from "@/components/topology/topology-canvas"
import { sharedLag } from "@/components/topology/lag-bundles"
import type {
  GroupEdgeInfo,
  TopoGroupData,
} from "@/components/topology/group-node"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { copyText } from "@/lib/clipboard"
import {
  useUrlCsv,
  useUrlEnum,
  useUrlFlag,
  useUrlInt,
  useUrlPatch,
  useUrlText,
} from "@/lib/use-url-state"
import {
  EMPTY_LEVELS,
  formatLevels,
  parseLevels,
  type LevelsState,
} from "@/components/topology/levels-param"
import {
  migratePositions,
  viewZones,
  ZONE_COLORS,
  ZONE_H,
  ZONE_W,
  type PosByStyle,
  type PosMap,
} from "@/components/topology/view-positions"
import { usePageTitle } from "@/lib/page-title"
import { cn } from "@/lib/utils"

const TopologyCanvas = lazy(() =>
  import("@/components/topology/topology-canvas").then((m) => ({
    default: m.TopologyCanvas,
  }))
)

/**
 * The map's whole configuration lives in the URL, so a topology is a link:
 * `?tab=hierarchy&site=<id>&color=speed` opens exactly that picture, survives
 * a reload, moves with back/forward, and is what a bookmark captures. A value
 * on its default is written as no param at all, so a plain map stays
 * `/topology`. Anything unrecognised reads back as the default rather than
 * breaking the page - see `docs/features/topology.md` for the full table.
 */
export interface TopologySearch {
  /** The view tab - public names, not the internal node style. */
  tab?: TabStyle
  /** Applied saved view (`/api/topology-views/`). Any other param present
   * alongside it is an override of that view - the toolbar says "edited". */
  view?: string
  site?: string
  location?: string
  role?: string
  status?: string
  tag?: string
  /** Show patch panels, i.e. don't collapse them away. */
  panels?: boolean
  group?: "site" | "location"
  dir?: "lr" | "tb"
  color?: EdgeColorMode
  cables?: "routed" | "straight" | "curved"
  /** Fold link-aggregation member cables into one edge ("on" by default). */
  lag?: "on" | "off"
  /** Levels organiser, encoded by `levels-param.ts`. */
  levels?: string
  /** Focused device + how many hops around it. */
  device?: string
  depth?: number
  /** Custom-map builder's device set. Present but empty = an empty map. */
  devices?: string
  /** Search box. */
  q?: string
  /** Logical tab. */
  vlangroup?: string
  vms?: boolean
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined
const oneOf = <T extends string>(v: unknown, valid: readonly T[]) =>
  typeof v === "string" && valid.includes(v as T) ? (v as T) : undefined
const flag = (v: unknown): boolean | undefined =>
  v === "1" || v === "true" || v === true
    ? true
    : v === "0" || v === "false" || v === false
      ? false
      : undefined

export const Route = createFileRoute("/topology/")({
  component: TopologyPage,
  validateSearch: (s: Record<string, unknown>): TopologySearch => {
    const out: TopologySearch = {}
    const tab = oneOf(s.tab, TAB_STYLES)
    if (tab) out.tab = tab
    const view = str(s.view)
    if (view) out.view = view
    for (const k of ["site", "location", "role", "status", "tag", "q",
      "vlangroup", "device", "levels"] as const) {
      const v = str(s[k])
      if (v) out[k] = v
    }
    const panels = flag(s.panels)
    if (panels !== undefined) out.panels = panels
    const vms = flag(s.vms)
    if (vms !== undefined) out.vms = vms
    const group = oneOf(s.group, ["site", "location"] as const)
    if (group) out.group = group
    const dir = oneOf(s.dir, ["lr", "tb"] as const)
    if (dir) out.dir = dir
    const color = oneOf(s.color, COLOR_MODES)
    if (color) out.color = color
    const lag = oneOf(s.lag, LAG_MODES)
    if (lag) out.lag = lag
    const cables = oneOf(s.cables, ROUTINGS)
    if (cables) out.cables = cables
    const depth = Number(s.depth)
    if (Number.isFinite(depth) && depth > 0)
      out.depth = Math.min(6, Math.round(depth))
    // "" is meaningful here (an empty builder map), so this one keeps a
    // present-but-empty string instead of dropping it.
    if (typeof s.devices === "string") out.devices = s.devices
    return out
  },
})

/** Params that describe the map itself - everything except the saved-view id.
 * Applying a view clears them all, so any one of them present afterwards means
 * the user has edited the view. */
const OVERRIDE_KEYS = [
  "tab", "site", "location", "role", "status", "tag", "panels", "group",
  "dir", "color", "cables", "lag", "levels", "device", "depth", "devices",
  "q", "vlangroup", "vms",
] as const

const Skeleton = () => (
  <div className="h-full w-full animate-pulse bg-muted/30" />
)

type Filters = {
  site: string
  role: string
  status: string
  tag: string
  collapse: boolean
}

/** Searchable filter select ("all" ↔ the combobox's null/none row) - the
 * option lists here (41 sites and counting) want type-to-filter. */
function FilterSelect({
  value,
  onChange,
  anyLabel,
  options,
}: {
  value: string
  onChange: (v: string) => void
  anyLabel: string
  options: { value: string; label: string }[]
}) {
  return (
    <Combobox
      value={value === "all" ? null : value}
      onChange={(v) => onChange(v ?? "all")}
      options={options}
      noneLabel={anyLabel}
      placeholder={anyLabel}
      className="h-8 w-full text-xs"
    />
  )
}

/** A labelled row inside the Filters / Display popovers. */
function PopoverField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}

/** A toolbar button's hover hint, on the shared tooltip. */
function BarTip({
  tip,
  children,
}: {
  tip: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" variant="panel">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

// Dragged node positions for the DEFAULT (no saved view) topology, kept in the
// browser so a manual arrangement survives a reload. The per-style split and
// the saved-view readers live in `view-positions.ts`.
const POS_KEY = "danbyte-topology-positions"

function readStoredPositions(style: NodeStyle): PosByStyle {
  try {
    const raw = localStorage.getItem(POS_KEY)
    return raw ? migratePositions(JSON.parse(raw), style) : {}
  } catch {
    return {}
  }
}
function writeStoredPositions(p: PosByStyle) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    /* quota / private mode - non-fatal */
  }
}
function clearStoredPositions() {
  try {
    localStorage.removeItem(POS_KEY)
  } catch {
    /* non-fatal */
  }
}

// Hidden cards and zones ride with the arrangement: they are part of how the
// default map is shaped, and a reload that forgot them would put back cards
// the user had just taken out.
// Derived from the reader rather than imported: this import block already
// carries the repo's inline-type-specifier debt and does not need two more.
type ZonesByStyle = ReturnType<typeof viewZones>
type Zone = NonNullable<ZonesByStyle["stencil"]>[number]

const HIDDEN_KEY = "danbyte-topology-hidden"
const ZONES_KEY = "danbyte-topology-zones"

function readStoredHidden(): TopoHidden {
  try {
    return readTopoHidden(JSON.parse(localStorage.getItem(HIDDEN_KEY)!))
  } catch {
    return NO_TOPO_HIDDEN
  }
}
function writeStoredHidden(h: TopoHidden) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(h))
  } catch {
    /* quota / private mode - non-fatal */
  }
}
function readStoredZones(): ZonesByStyle {
  try {
    return viewZones(JSON.parse(localStorage.getItem(ZONES_KEY)!))
  } catch {
    return {}
  }
}
function writeStoredZones(z: ZonesByStyle) {
  try {
    localStorage.setItem(ZONES_KEY, JSON.stringify(z))
  } catch {
    /* non-fatal */
  }
}

// Display settings (Levels order/bonds/distances, direction, colour mode,
// edge routing) for the DEFAULT topology - like the dragged positions above,
// they must survive a reload. Saved views persist theirs via Save.
const DISPLAY_KEY = "danbyte-topology-display"
const SIDEBAR_KEY = "topology:sidebar"
const EMPTY_MON: BulkStatusResponse["statuses"] = {}
interface StoredDisplay {
  colorMode?: EdgeColorMode
  direction?: "LR" | "TB"
  roleOrder?: string[]
  roleBonds?: string[]
  roleDistance?: Record<string, number>
  edgeRouting?: "routed" | "straight" | "curved"
  viewStyle?: ViewStyle
  groupBy?: GroupBy
}

type GroupBy = "none" | "site" | "location"
/** The page's views: the canvas styles + the VLAN-rail diagram. */
type ViewStyle = NodeStyle | "logical"
const VIEW_STYLES: ViewStyle[] = ["stencil", "hierarchy", "flat", "logical"]
/** Stored values may name a removed view (e.g. the scrapped Faceplates). */
function sanitizeViewStyle(v: unknown): ViewStyle {
  return VIEW_STYLES.includes(v as ViewStyle) ? (v as ViewStyle) : "stencil"
}
/** The URL says what the tab strip says. "stencil" is an internal name for
 * the renderer; the tab - and the link - call it Wiring. */
type TabStyle = "wiring" | "hierarchy" | "flat" | "logical"
const TAB_STYLES = ["wiring", "hierarchy", "flat", "logical"] as const
const COLOR_MODES = ["cable", "type", "status", "speed", "none"] as const
const DIRS = ["lr", "tb"] as const
const ROUTINGS = ["routed", "straight", "curved"] as const
const LAG_MODES = ["on", "off"] as const
const GROUPS = ["none", "site", "location"] as const
const styleOfTab = (t: TabStyle): ViewStyle => (t === "wiring" ? "stencil" : t)
const tabOfStyle = (v: ViewStyle): TabStyle => (v === "stencil" ? "wiring" : v)

/** What a saved view stores in `state.filters` - the map's settings under the
 * page's own names. Unchanged by the URL work: a view saved before it still
 * applies, and still supplies the fallback for anything the URL omits. */
type ViewFilters = Partial<
  Filters & {
    location: string
    colorMode: EdgeColorMode
    direction: "LR" | "TB"
    roleOrder: string[]
    roleBonds: string[]
    roleDistance: Record<string, number>
    edgeRouting: "routed" | "straight" | "curved"
    viewStyle: ViewStyle
    groupBy: GroupBy
    lag: "on" | "off"
    devices: string[]
  }
>
function readStoredDisplay(): StoredDisplay {
  try {
    const raw = localStorage.getItem(DISPLAY_KEY)
    return raw ? (JSON.parse(raw) as StoredDisplay) : {}
  } catch {
    return {}
  }
}
function writeStoredDisplay(d: StoredDisplay) {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(d))
  } catch {
    /* quota / private mode - non-fatal */
  }
}

/** One saved view, state included. */
const fetchView = (id: string) =>
  api<TopologyViewSaved>(`/api/topology-views/${id}/`)

// The default map's whole document, in a saved view's `state` shape, so
// what a view saves beyond the arrangement - the Diagram's display, link and
// card overrides, notes - survives a reload here too. The positions, zones
// and hidden keys are still written, and read when this one is missing, for
// one release.
const MAP_KEY = "danbyte-topology-map"

function readStoredMap(): ViewDocument | null {
  try {
    return readDefaultMap(localStorage.getItem(MAP_KEY), sanitizeViewStyle)
  } catch {
    return null
  }
}
function writeStoredMap(doc: ViewDocument) {
  try {
    localStorage.setItem(MAP_KEY, storedDefaultMap(doc))
  } catch {
    // A copy that could not be updated must not outlive the older keys.
    try {
      localStorage.removeItem(MAP_KEY)
    } catch {
      /* non-fatal */
    }
  }
}

/** The default map as this browser last left it. A legacy single-map
 * arrangement is read as the style on screen. */
function defaultDocument(style: ViewStyle): ViewDocument {
  return (
    readStoredMap() ??
    emptyDocument({
      positions: readStoredPositions(style as NodeStyle),
      zones: readStoredZones(),
      hidden: readStoredHidden(),
    })
  )
}

function TopologyPage() {
  usePageTitle("Topology")
  const urlSearch = Route.useSearch()
  const nav = useNavigate()
  const patch = useUrlPatch()
  const { canDo } = useMe()
  const qc = useQueryClient()
  const canvas = useRef<CanvasHandle>(null)

  // The select lists names only; the applied view - the one whose state is
  // needed - is fetched by id. It supplies the fallback for every control
  // the URL doesn't override.
  const views = useQuery({
    queryKey: ["topology-views", "picker"],
    queryFn: () =>
      api<Paginated<TopologyViewSummary>>("/api/topology-views/?picker=1"),
  })
  const viewId = urlSearch.view ?? "none"
  const viewQ = useQuery({
    queryKey: ["topology-view", viewId],
    queryFn: () => fetchView(viewId),
    enabled: viewId !== "none",
  })
  const appliedView = viewId !== "none" ? viewQ.data : undefined
  const vf = (appliedView?.state.filters ?? {}) as ViewFilters
  // Personal defaults from the last unsaved session (this read is unchanged
  // from before the URL work - same hydration behaviour).
  const stored = useRef(readStoredDisplay()).current

  // Value resolution for every control below:
  //   URL param → applied saved view → stored personal default → hard default.
  // The hooks take the fallback as a plain value, so the chain is just this
  // object. "all" / "none" are spelled out rather than left absent, because a
  // link that turns a saved view's filter OFF has to say so - an absent param
  // would inherit the view's value again.
  const dflt = {
    tab: tabOfStyle(sanitizeViewStyle(vf.viewStyle ?? stored.viewStyle)),
    color: vf.colorMode ?? stored.colorMode ?? "cable",
    dir: (vf.direction ?? stored.direction ?? "LR") === "TB" ? "tb" : "lr",
    cables: vf.edgeRouting ?? stored.edgeRouting ?? "routed",
    group: vf.groupBy ?? stored.groupBy ?? "none",
    panels: vf.collapse === undefined ? false : !vf.collapse,
    site: vf.site ?? "all",
    location: vf.location ?? "all",
    role: vf.role ?? "all",
    status: vf.status ?? "all",
    tag: vf.tag ?? "all",
    levels: formatLevels({
      order: vf.roleOrder ?? stored.roleOrder ?? [],
      bonds: vf.roleBonds ?? stored.roleBonds ?? [],
      distance: vf.roleDistance ?? stored.roleDistance ?? {},
    }),
    devices: vf.devices ?? null,
  } as const

  const [tab, setTab] = useUrlEnum<TabStyle>("tab", dflt.tab, TAB_STYLES)
  const viewStyle = styleOfTab(tab)
  const setViewStyle = (v: ViewStyle) => setTab(tabOfStyle(v))
  const [colorMode, setColorMode] = useUrlEnum<EdgeColorMode>(
    "color",
    dflt.color,
    COLOR_MODES
  )
  const [dirParam, setDirParam] = useUrlEnum("dir", dflt.dir, DIRS)
  const direction: "LR" | "TB" = dirParam === "tb" ? "TB" : "LR"
  const setDirection = (d: "LR" | "TB") => setDirParam(d === "TB" ? "tb" : "lr")
  // Edge rendering: "routed" bends cables around cards; "straight" is the plain
  // orthogonal (smoothstep) line. A user choice, not tied to layout mode.
  const [edgeRouting, setEdgeRouting] = useUrlEnum(
    "cables",
    dflt.cables,
    ROUTINGS
  )
  const [lagMode, setLagMode] = useUrlEnum(
    "lag",
    oneOf(vf.lag, LAG_MODES) ?? "on",
    LAG_MODES
  )
  const logical = viewStyle === "logical"
  // Aggregate the graph to one card per site/location; double-click a card
  // (or its panel's button) drills into that group's device view.
  const [groupBy] = useUrlEnum<GroupBy>("group", dflt.group, GROUPS)
  // Levels (role tiers) travel as one compact param.
  const [levelsParam, setLevelsParam] = useUrlText("levels", dflt.levels)
  const levels = parseLevels(levelsParam) ?? EMPTY_LEVELS
  const roleOrder = levels.order
  // Roles bonded to the level of the role above them - lets several roles share
  // one level (core switches beside routers, say).
  const roleBonds = levels.bonds
  const roleDistance = levels.distance
  const setLevels = (next: Partial<LevelsState>) =>
    setLevelsParam(formatLevels({ ...levels, ...next }))
  const setRoleOrder = (order: string[]) => setLevels({ order })
  const setRoleBonds = (bonds: string[]) => setLevels({ bonds })
  const setRoleDistance = (distance: Record<string, number>) =>
    setLevels({ distance })

  const [siteF] = useUrlText("site", dflt.site)
  const [locationF] = useUrlText("location", dflt.location)
  const [roleF] = useUrlText("role", dflt.role)
  const [statusF] = useUrlText("status", dflt.status)
  const [tagF] = useUrlText("tag", dflt.tag)
  // The UI (and the URL) talk about SHOWING panels; the API collapses them.
  const [panels] = useUrlFlag("panels", dflt.panels)
  const filters: Filters = {
    site: siteF,
    role: roleF,
    status: statusF,
    tag: tagF,
    collapse: !panels,
  }

  // Drilled into one group = grouping is on AND that group's own id is set
  // (`?group=site&site=<id>`). No third piece of state, and no separate
  // spelling to learn: grouping by site while scoped to one site IS that
  // site's device view. The name for the breadcrumb comes from the picker
  // lists further down.
  const drillId =
    groupBy === "site" ? siteF : groupBy === "location" ? locationF : "all"
  const drilled = groupBy !== "none" && drillId !== "all"
  const grouped = groupBy !== "none" && !drilled
  // Custom-map builder: a hand-picked device set (right-click to grow it,
  // the + button to seed it). null = normal mode.
  const [custom, setCustom] = useUrlCsv("devices", dflt.devices)
  const builder = custom !== null
  const [menu, setMenu] = useState<{
    x: number
    y: number
    /** Canvas coordinates - a zone is created where the click landed, not
     * where the screen happens to be. */
    fx?: number
    fy?: number
    node?: TopoNode["data"]
    nodeId?: string
    group?: TopoGroupData
    zoneId?: string
  } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useUrlText("q", "", { replace: true })
  const [focusId] = useUrlText("device")
  const [focusDepth, setFocusDepth] = useUrlInt("depth", 1, { min: 1, max: 6 })
  const focus = focusId ? { id: focusId, depth: focusDepth } : null
  const setFocus = (f: { id: string; depth: number } | null) =>
    patch({
      device: f ? f.id : undefined,
      depth: f && f.depth !== 1 ? String(f.depth) : undefined,
    })
  // Which map is on screen. A saved view carries its own arrangement, zones
  // and hidden set; the default map keeps its own in this browser; a custom
  // map is a scratch map until it is saved, so what you draw on it must not
  // follow you back to the default map when you exit.
  const mapKey =
    viewId !== "none" ? `view:${viewId}` : builder ? "custom" : "default"

  // Everything about this map that is not in the URL - the arrangements,
  // zones, hidden set, overrides - as one undoable document. A saved view's
  // arrives with the view (the load effect below); the default map starts
  // from this browser's copy.
  const doc = useViewDocument(() => {
    if (urlSearch.view) return { doc: emptyDocument(), key: mapKey }
    if (builder) return { doc: emptyDocument(), key: mapKey }
    return { doc: defaultDocument(styleOfTab(dflt.tab)), key: mapKey }
  })
  const { dispatch: send, dirtyRef } = doc
  /** One user action = one undo step, however many edits it makes (a zone
   * drag also snapshots the cards). */
  const edit = (action: Parameters<typeof send>[0]) =>
    send(action, { coalesce: "gesture" })

  // One arrangement per view style - see PosByStyle. The canvas only ever
  // sees the style it is currently drawing.
  const positions = logical ? undefined : doc.doc.positions[viewStyle]
  /** Every style's arrangement is stale - the map is about to hold a
   * different set of devices. */
  const dropAllPositions = () => edit({ type: "clearPositions" })

  // What is switched off on this map - by site, location, role, link family
  // (the sidebar's eyes) or one card by hand ("Remove from view"). Not a
  // filter: a filter says what kind of thing belongs, this says "not that
  // one" - the last mile of a diagram you are shaping for someone to read.
  const hidden = doc.doc.hidden
  const setHiddenNodes = (next: TopoHidden) =>
    edit({ type: "setHidden", hidden: next })
  // Labelled backdrop boxes, per view style - a box framing Flat chips is
  // the wrong size around Stencil cards.
  const zones = logical ? undefined : doc.doc.zones[viewStyle]
  const setZones = (next: Zone[]) => {
    if (logical) return
    edit({ type: "setRegions", style: viewStyle, regions: next })
  }
  const addZone = (x: number, y: number) =>
    setZones([
      ...(zones ?? []),
      {
        id: `z${Date.now().toString(36)}`,
        label: "Zone",
        // Dropped centred on the click, which is where the eye is.
        x: Math.round(x - ZONE_W / 2),
        y: Math.round(y - ZONE_H / 2),
        w: ZONE_W,
        h: ZONE_H,
        color: ZONE_COLORS[(zones?.length ?? 0) % ZONE_COLORS.length],
      },
    ])
  /** The toolbar button has no click point, so the box lands in the middle
   * of what is on screen - where the user is looking. */
  const addZoneCentered = () => {
    const c = canvas.current?.center()
    addZone(c?.x ?? 0, c?.y ?? 0)
  }
  const removeZone = (id: string) =>
    setZones((zones ?? []).filter((z) => z.id !== id))
  const recolorZone = (id: string, color: string) =>
    setZones((zones ?? []).map((z) => (z.id === id ? { ...z, color } : z)))

  const [layoutTick, setLayoutTick] = useState(0)

  // The ONE place a map's document is (re)loaded. An effect, because a map
  // arrives several ways - picked in the select, opened as a link in a fresh
  // tab, refetched, left for the default map - and the first fix that only
  // covered the click left cold links opening with the personal default's
  // coordinates pinned under the view's graph. A saved view's key carries
  // its `updated_at`: a newer copy (someone else saved) replaces a clean
  // document, but never unsaved edits - their Save reports the conflict.
  const loadedKey = useRef<string>(
    urlSearch.view ? `${mapKey}@pending` : mapKey
  )
  useEffect(() => {
    const view = mapKey.startsWith("view:")
    const key = !view
      ? mapKey
      : `${mapKey}@${appliedView?.updated_at ?? "pending"}`
    const prev = loadedKey.current
    if (prev === key) return
    const sameView =
      view && prev.startsWith(`${mapKey}@`) && prev !== `${mapKey}@pending`
    if (view && !appliedView) {
      // Still fetching: a background refetch keeps what is there; a view
      // just switched to starts blank rather than showing the last map's.
      if (sameView) return
      doc.load(emptyDocument(), mapKey)
    } else if (sameView && dirtyRef.current) {
      return
    } else if (appliedView) {
      doc.load(
        docFromView(appliedView, sanitizeViewStyle),
        mapKey,
        appliedView.updated_at
      )
    } else if (mapKey === "custom") {
      doc.load(emptyDocument(), mapKey)
    } else {
      doc.load(defaultDocument(viewStyle), mapKey)
    }
    loadedKey.current = key
    setLayoutTick((t) => t + 1)
    // Keyed on the map and the view copy only: the style and the document
    // are read as they are at that moment, not reasons to reload.
  }, [mapKey, appliedView])

  // The default map persists to this browser as it changes; a saved view's
  // document is written by Save. Keyed on the document's own map, so the
  // frame between leaving a view and loading the default map can never
  // write the view's arrangement into the default map's storage.
  const ownDefault = doc.docKey === "default"
  const { positions: docPositions, zones: docZones } = doc.doc
  useEffect(() => {
    if (!ownDefault) return
    if (Object.keys(docPositions).length) writeStoredPositions(docPositions)
    else clearStoredPositions()
  }, [ownDefault, docPositions])
  useEffect(() => {
    if (ownDefault) writeStoredZones(docZones)
  }, [ownDefault, docZones])
  useEffect(() => {
    if (ownDefault) writeStoredHidden(hidden)
  }, [ownDefault, hidden])
  const docNow = doc.doc
  useEffect(() => {
    if (ownDefault) writeStoredMap(docNow)
  }, [ownDefault, docNow])
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [ghost, setGhost] = useState<GhostEdgeData | null>(null)
  const [selNode, setSelNode] = useState<TopoNode["data"] | null>(null)
  const [selEdge, setSelEdge] = useState<NonNullable<TopoEdge["data"]> | null>(
    null
  )
  const [selBundle, setSelBundle] = useState<BundleMember[] | null>(null)
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null)
  const [selGroup, setSelGroup] = useState<TopoGroupData | null>(null)
  const [selGroupEdge, setSelGroupEdge] = useState<GroupEdgeInfo | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)
  // The objects sidebar is a per-browser preference, as on the site map.
  const [showObjects, setShowObjects] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) !== "closed"
  )
  const toggleObjects = () =>
    setShowObjects((v) => {
      localStorage.setItem(SIDEBAR_KEY, v ? "closed" : "open")
      return !v
    })

  const clearSel = () => {
    setSelNode(null)
    setSelEdge(null)
    setSelBundle(null)
    setSelGroup(null)
    setSelGroupEdge(null)
    setSelEdgeId(null)
  }

  /** Drilling in scopes the map to that one group - which the URL already has
   * a spelling for, so this is a filter change, not a mode. */
  const drillInto = (d: TopoGroupData) => {
    if (!d.group_id) return
    patch({ [d.kind]: d.group_id })
    clearSel()
    dropAllPositions()
  }

  const leaveDrill = () => {
    patch({ [groupBy === "location" ? "location" : "site"]: "all" })
    clearSel()
    dropAllPositions()
  }

  /** Builder: merge ids into the custom set (starting it if needed). */
  const addToCustom = (ids: string[]) =>
    setCustom([...new Set([...(custom ?? []), ...ids])])

  /** Leaving the builder. A saved view whose whole point IS its device set
   * can't survive losing it, so that view is left behind too. The map the
   * user lands on brings its own arrangement (the load effect), and a view
   * built on by hand keeps the positions of the cards it still shows. */
  const exitBuilder = () => {
    patch({ devices: undefined, ...(vf.devices ? { view: undefined } : {}) })
    clearSel()
  }

  /** Builder: pull one device's 1-hop neighbourhood into the set. */
  const addNeighbors = async (deviceId: string) => {
    try {
      const g = await api<TopologyGraph>(
        `/api/topology/?device=${deviceId}&depth=1`
      )
      addToCustom(
        g.nodes
          .map((n) => n.data.device_id)
          .filter((x): x is string => !!x)
      )
    } catch (err) {
      apiErrorToast(err)
    }
  }

  /** A filter change writes its params in ONE navigation (separate setters in
   * the same tick would overwrite each other) and drops hand-tuned positions,
   * since the map is about to hold different devices. An applied saved view
   * stays applied - the change rides on top of it as an override, which is
   * what the toolbar's "edited" reports. */
  const set = (next: Partial<Filters>) => {
    // A value that already matches this map's default is written as no param,
    // the same rule the single-value hooks follow - so a filter set back to
    // "all" leaves a clean URL, while turning a saved view's filter off says
    // `site=all` explicitly.
    const w = (v: string, d: string) => (v === d ? undefined : v)
    patch({
      ...(next.site !== undefined ? { site: w(next.site, dflt.site) } : {}),
      ...(next.role !== undefined ? { role: w(next.role, dflt.role) } : {}),
      ...(next.status !== undefined
        ? { status: w(next.status, dflt.status) }
        : {}),
      ...(next.tag !== undefined ? { tag: w(next.tag, dflt.tag) } : {}),
      ...(next.collapse !== undefined
        ? {
            panels:
              !next.collapse === dflt.panels
                ? undefined
                : next.collapse
                  ? "0"
                  : "1",
          }
        : {}),
    })
    dropAllPositions()
  }

  // Persist the DEFAULT view's display settings across reloads. Only while no
  // saved view is selected - a saved view's settings belong to that view.
  useEffect(() => {
    if (viewId !== "none") return
    writeStoredDisplay({
      colorMode,
      direction,
      roleOrder,
      roleBonds,
      roleDistance,
      edgeRouting,
      viewStyle,
      groupBy,
    })
  }, [
    viewId,
    colorMode,
    direction,
    roleOrder,
    roleBonds,
    roleDistance,
    edgeRouting,
    viewStyle,
    groupBy,
  ])

  // ── Option lists (shared picker caches) ──
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-roles/?picker=1"
      ),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["device-statuses-picker"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=device&picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  // Locations back the group-by-location breadcrumb: a `?group=location&
  // location=<id>` link arrives with no name for the group it drilled into.
  const locations = useQuery({
    queryKey: ["locations-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/locations/?picker=1"),
    staleTime: 10 * 60_000,
    enabled: groupBy === "location",
  })
  // The group we drilled into, named for the breadcrumb from the picker lists
  // (a URL can land here cold, so the name is looked up, not remembered).
  const drill = useMemo(() => {
    if (!drilled) return null
    const kind = groupBy === "location" ? "location" : "site"
    const from =
      kind === "site" ? sites.data?.results : locations.data?.results
    return {
      kind: kind as "site" | "location",
      id: drillId,
      name: from?.find((x) => x.id === drillId)?.name ?? "…",
    }
  }, [drilled, groupBy, drillId, sites.data, locations.data])

  // ── Graph ──
  // A device set is POSTed (fetchTopology): a builder map of a few hundred
  // ids would overflow the server's request line as a query string.
  const graphQuery = useMemo<TopologyQuery>(() => {
    const collapse_panels = filters.collapse
    // Builder mode: exactly this set, nothing else.
    if (custom !== null) return { devices: custom, collapse_panels }
    if (focus && !grouped)
      return { device: focus.id, depth: focus.depth, collapse_panels }
    const g: TopologyQuery = { collapse_panels }
    if (filters.site !== "all") g.site = filters.site
    if (filters.role !== "all") g.role = filters.role
    if (filters.status !== "all") g.status = filters.status
    if (filters.tag !== "all") g.tag = filters.tag
    if (grouped) g.group_by = groupBy
    // Drilled into a group: the device view scoped to that one group. Its
    // id is already on the matching filter param, so nothing extra here.
    if (drill && drill.kind === "location") g.location = drill.id
    return g
  }, [filters, focus, grouped, groupBy, drill, custom])
  /** Changes exactly when the query does - the canvas refits on a new one. */
  const graphKey = useMemo(() => JSON.stringify(graphQuery), [graphQuery])

  const q = useQuery({
    queryKey: ["topology", graphQuery],
    queryFn: ({ signal }) => fetchTopology(graphQuery, { signal }),
    enabled: !logical,
  })

  /** Replace the arrangement of the style on screen (undefined = re-layout
   * it); every other style keeps the one the user tuned. The canvas only
   * knows the cards this user can see, so a saved position of any card the
   * query did not return is kept - a narrower user saving a shared view
   * must not wipe how everybody else's cards were arranged. */
  const setPositions = (p: PosMap | undefined) => {
    if (logical) return
    edit({
      type: "setPositions",
      style: viewStyle,
      positions: p ?? null,
      seen: q.data?.nodes.map((n) => n.id),
    })
  }
  const ghosts = useQuery({
    queryKey: ["topology-ghosts", filters.site],
    enabled: !logical,
    queryFn: () =>
      api<{ edges: TopoEdge[] }>(
        `/api/monitoring/topology/ghosts/${
          filters.site !== "all" ? `?site=${filters.site}` : ""
        }`
      ),
  })

  const bgp = useQuery({
    queryKey: ["topology-bgp", filters.site],
    enabled: !logical,
    queryFn: () =>
      api<{ edges: TopoEdge[] }>(
        `/api/routing/topology/bgp/${
          filters.site !== "all" ? `?site=${filters.site}` : ""
        }`
      ),
  })

  /** Everything the query returned plus the LLDP ghosts and BGP sessions
   * between those cards - what the sidebar lists, hidden or not. */
  const fullGraph = useMemo<TopologyGraph | undefined>(() => {
    if (!q.data) return undefined
    const present = new Set(q.data.nodes.map((n) => n.id))
    const between = (e: TopoEdge) =>
      present.has(e.source) && present.has(e.target)
    const ghostEdges = (ghosts.data?.edges ?? []).filter(between)
    const bgpEdges = (bgp.data?.edges ?? []).filter(between)
    return { ...q.data, edges: [...q.data.edges, ...ghostEdges, ...bgpEdges] }
  }, [q.data, ghosts.data, bgp.data])
  /** What the canvas draws. How many cards hiding took off THIS map is the
   * chip's count - a view saved against one filter can carry names the
   * current query never returns, and offering to restore those would be a
   * lie. */
  const graph = useMemo(
    () => (fullGraph ? applyHidden(fullGraph, hidden) : undefined),
    [fullGraph, hidden]
  )
  const hiddenHere = fullGraph ? hiddenOnMap(fullGraph, hidden) : 0

  // Media types on the map - the legend swatches them in type color mode.
  const presentTypes = useMemo(() => {
    const s = new Set<string>()
    for (const e of graph?.edges ?? [])
      if (e.data?.cable_type) s.add(e.data.cable_type)
    return [...s].sort()
  }, [graph])

  // ── Search → dim non-matching nodes; Enter zooms to the first hit ──
  const matchedIds = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle || !graph) return null
    return new Set(
      graph.nodes
        .filter((n) => {
          const d = n.data
          return (
            d.name.toLowerCase().includes(needle) ||
            (d.primary_ip ?? "").includes(needle) ||
            (d.device_type ?? "").toLowerCase().includes(needle)
          )
        })
        .map((n) => n.id)
    )
  }, [search, graph])

  // H hides the selected card (or, when grouped, the selected site or
  // location) as its eye would; Shift+H shows all.
  const selNodeId = selNode?.device_id ? `dev:${selNode.device_id}` : null
  useHideKeys(
    !logical && selNodeId
      ? () => {
          setHiddenNodes(withHidden(hidden, "devices", selNodeId, true))
          clearSel()
        }
      : !logical && selGroup
        ? () => {
            setHiddenNodes(
              withHidden(
                hidden,
                selGroup.kind === "site" ? "sites" : "locations",
                selGroup.name,
                true
              )
            )
            clearSel()
          }
        : null,
    () => setHiddenNodes(NO_TOPO_HIDDEN)
  )

  // Monitoring roll-up for the sidebar's chips - the graph payload carries
  // none, and the api app stays decoupled from the monitoring app.
  const deviceIds = useMemo(
    () =>
      (graph?.nodes ?? [])
        .map((n) => n.data.device_id)
        .filter((x): x is string => !!x)
        .sort(),
    [graph]
  )
  const monQuery = useQuery({
    queryKey: ["device-mon-status", deviceIds],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ devices: deviceIds }),
      }),
    enabled: showObjects && !logical && deviceIds.length > 0,
    staleTime: 30_000,
  })
  const checks = monQuery.data?.statuses ?? EMPTY_MON

  // ── Saved views ──
  // Save needs `change` on the view; Save as (and Ctrl+S on a map that is
  // not a view yet) needs `add`.
  const canChangeViews = canDo("topologyview", "change")
  const canAddViews = canDo("topologyview", "add")
  const canDeleteViews = canDo("topologyview", "delete")
  const noOverrides = () =>
    Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, undefined]))

  /** Applying a view is one navigation to `?view=<id>`, clearing every other
   * param: the view's own settings then supply the fallbacks, so the link
   * stays short and keeps showing the view as it is saved today. Anything the
   * user changes afterwards lands back on the URL as an override, which is
   * what `edited` below reports. The view's document follows through the
   * load effect - and through the leave guard, if this map has edits. */
  const applyView = (v: TopologyViewSummary) =>
    patch({ view: v.id, ...noOverrides() })

  /** Back to the personal default map: no view, no overrides. */
  const clearView = () => patch({ view: undefined, ...noOverrides() })

  /** The applied view is no longer what it saved - the URL carries at least
   * one override on top of `?view=`, or the map itself was edited. */
  const edited =
    viewId !== "none" &&
    (doc.dirty ||
      OVERRIDE_KEYS.some(
        (k) => (urlSearch as Record<string, unknown>)[k] !== undefined
      ))
  /** A view's own document is on screen (not the blank one shown while it
   * loads) - saving before that would write an empty map over it. */
  const docReady =
    viewId === "none" || (doc.docKey === mapKey && doc.base !== null)

  /** What Save writes: the document, under the settings the URL holds. */
  const currentState = () =>
    toViewState(doc.doc, {
      filters: {
        ...filters,
        colorMode,
        direction,
        roleOrder,
        roleBonds,
        roleDistance,
        edgeRouting,
        viewStyle,
        groupBy,
        lag: lagMode,
      },
      devices: custom,
      style: viewStyle,
    })

  const [stale, setStale] = useState(false)
  const [reloading, setReloading] = useState(false)
  // A fresh dialog per opening, so "Save as copy" can hand it a name.
  const [saveAsSeed, setSaveAsSeed] = useState({ n: 0, name: "" })
  const openSaveAs = (name = "") => {
    setSaveAsSeed((cur) => ({ n: cur.n + 1, name }))
    setSaveAsOpen(true)
  }

  const saveView = useMutation({
    mutationFn: (a: {
      id?: string
      name?: string
      state: TopologyViewState
      doc: ViewDocument
      base: string | null
    }) => {
      if (a.id)
        return api<TopologyViewSaved>(`/api/topology-views/${a.id}/`, {
          method: "PATCH",
          // The copy these edits started from: a view saved again since
          // is refused with 409 rather than silently overwritten.
          body: JSON.stringify({
            state: a.state,
            ...(a.base ? { base_updated_at: a.base } : {}),
          }),
        })
      return api<TopologyViewSaved>("/api/topology-views/", {
        method: "POST",
        body: JSON.stringify({ name: a.name, state: a.state }),
      })
    },
    onSuccess: (v, a) => {
      qc.setQueryData(["topology-view", v.id], v)
      qc.invalidateQueries({ queryKey: ["topology-views"] })
      // The document is what the server holds now - it keeps its history,
      // so the save can be undone, and the refetch of this copy is no news.
      loadedKey.current = `view:${v.id}@${v.updated_at}`
      doc.markSaved(a.doc, `view:${v.id}`, v.updated_at)
      // The saved view now describes the map, so the overrides that produced
      // it are no longer overrides - the URL collapses back to just the id.
      // Past the leave guard: this is the map it saved, and an edit made
      // while the save was in flight stays in the document, unsaved.
      patch({ view: v.id, ...noOverrides() }, { ignoreBlocker: true })
      setSaveAsOpen(false)
      toast.success(`Saved “${v.name}”`)
    },
    onError: (err, a) => {
      if (a.id && isStaleViewError(err)) setStale(true)
      else apiErrorToast(err)
    },
  })
  const save = (id?: string, name?: string) =>
    saveView.mutate({
      id,
      name,
      state: currentState(),
      doc: doc.doc,
      base: id ? doc.base : null,
    })
  const savingInPlace = saveView.isPending && !!saveView.variables.id

  /** After a refused save: take the newer copy, dropping this map's edits
   * and overrides. */
  const reloadView = async () => {
    if (viewId === "none") return
    setReloading(true)
    try {
      const v = await qc.fetchQuery({
        queryKey: ["topology-view", viewId],
        queryFn: () => fetchView(viewId),
        staleTime: 0,
      })
      loadedKey.current = `view:${v.id}@${v.updated_at}`
      doc.load(docFromView(v, sanitizeViewStyle), `view:${v.id}`, v.updated_at)
      setLayoutTick((t) => t + 1)
      patch({ view: v.id, ...noOverrides() })
      setStale(false)
    } catch (err) {
      apiErrorToast(err)
    } finally {
      setReloading(false)
    }
  }

  const deleteView = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/topology-views/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["topology-views"] })
      // Nothing is left to keep the edits in, so there is nothing for the
      // leave guard to ask; the default map loads on the way out.
      doc.load(emptyDocument(), mapKey)
      clearView()
      toast.success("View deleted")
    },
    onError: (err) => apiErrorToast(err),
  })

  // ── Keyboard ──
  /** Ctrl/Cmd+S: Save in place where allowed, else Save as. False leaves
   * the key to the browser. */
  const saveShortcut = () => {
    if (logical) return false
    if (saveView.isPending || saveAsOpen || stale) return true
    if (viewId !== "none" && canChangeViews) {
      if (docReady) save(viewId)
      return true
    }
    if (canAddViews) {
      openSaveAs()
      return true
    }
    return false
  }
  /** A style whose arrangement steps back to "none" has to be laid out
   * again - the canvas otherwise keeps the cards where they were dragged. */
  const stepHistory = (back: boolean) => {
    const style = viewStyle as NodeStyle
    const before = doc.doc.positions[style]
    const to = back ? doc.undo() : doc.redo()
    if (to && before && !to.positions[style]) setLayoutTick((t) => t + 1)
  }
  useDocumentKeys({
    enabled: !logical,
    onSave: saveShortcut,
    onUndo: () => stepHistory(true),
    onRedo: () => stepHistory(false),
  })

  // ── Unsaved-edit guard ──
  // See useMapLeaveGuard: another map (view, default, custom) is a leave, a
  // filter change on this one is not.
  const leaveGuard = useMapLeaveGuard(doc)

  /** This map, as a link someone else can open. */
  const copyLink = async () => {
    const ok = await copyText(window.location.href)
    if (ok) toast.success("Link copied")
    else toast.error("Couldn't copy - clipboard blocked by the browser")
  }

  const exportPng = async (viewportOnly = false) => {
    const url = await canvas.current?.exportPng(viewportOnly)
    if (!url) return
    const a = document.createElement("a")
    a.href = url
    a.download = "topology.png"
    a.click()
  }

  // Roles present on the map, for the Level organiser.
  const rolesInGraph = useMemo(() => {
    const seen = new Map<string, string | undefined>()
    for (const n of graph?.nodes ?? [])
      if (
        n.data.role &&
        !n.data.role.is_patch_panel &&
        !seen.has(n.data.role.name)
      )
        seen.set(n.data.role.name, n.data.role.color)
    return [...seen].map(([name, color]) => ({ name, color }))
  }, [graph])

  const count = q.data?.nodes.length ?? 0
  const activeFilters = [
    filters.site,
    filters.role,
    filters.status,
    filters.tag,
  ].filter((v) => v !== "all").length
  const focusName = focus
    ? (graph?.nodes.find((n) => n.data.device_id === focus.id)?.data.name ??
      "device")
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden">
        <h1 className="text-base font-semibold">Topology</h1>
        {q.data && (
          <Badge variant="secondary" className="shrink-0">
            {count}{" "}
            {grouped
              ? count === 1
                ? "group"
                : "groups"
              : count === 1
                ? "device"
                : "devices"}
          </Badge>
        )}
        {drill && (
          <Badge variant="default" className="shrink-0 gap-1">
            {drill.name}
            <button
              className="ml-0.5 opacity-80 hover:opacity-100"
              onClick={leaveDrill}
              aria-label="Back to groups"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        {builder && (
          <Badge variant="default" className="shrink-0 gap-1">
            Custom map · <span className="num">{custom?.length ?? 0}</span>
            <button
              className="ml-0.5 opacity-80 hover:opacity-100"
              onClick={exitBuilder}
              aria-label="Exit custom map"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        <SegmentedTabs<ViewStyle>
          value={viewStyle}
          onValueChange={(v) => {
            // Each style keeps its OWN arrangement: switching away doesn't
            // discard it, and switching back restores it. The canvas treats
            // the style change itself as a relayout, so no tick here - a
            // tick fired now would land on the OUTGOING style (the style
            // rides on the URL, which updates a beat later).
            setViewStyle(v)
          }}
          items={[
            { value: "stencil", label: "Wiring" },
            { value: "hierarchy", label: "Hierarchy" },
            { value: "flat", label: "Flat" },
            { value: "logical", label: "Logical" },
          ]}
        />
        {focus && (
          <Badge variant="default" className="shrink-0 gap-1">
            <Crosshair className="h-3 w-3" />
            {focusName} · {focus.depth} hop{focus.depth === 1 ? "" : "s"}
            <button
              className="ml-0.5 opacity-80 hover:opacity-100"
              onClick={() => setFocus(null)}
              aria-label="Clear focus"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!logical && (
          <>
          <Input
            placeholder="Find device…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matchedIds?.size)
                canvas.current?.focusNode([...matchedIds][0])
            }}
            className="h-8 w-40 text-xs"
          />
          {builder ? null : focus ? (
            <Select
              value={String(focus.depth)}
              onValueChange={(v) => setFocusDepth(Number(v))}
            >
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} hop{d === 1 ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 text-xs"
                >
                  <Filter className="h-3.5 w-3.5" />
                  Filters
                  {activeFilters > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-0.5 h-4 px-1 text-[10px]"
                    >
                      {activeFilters}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-3 p-3">
                <PopoverField label="Site">
                  <FilterSelect
                    value={filters.site}
                    onChange={(v) => set({ site: v })}
                    anyLabel="All sites"
                    options={(sites.data?.results ?? []).map((s) => ({
                      value: s.id,
                      label: s.name,
                    }))}
                  />
                </PopoverField>
                <PopoverField label="Role">
                  <FilterSelect
                    value={filters.role}
                    onChange={(v) => set({ role: v })}
                    anyLabel="Any role"
                    options={(roles.data?.results ?? []).map((r) => ({
                      value: r.id,
                      label: r.name,
                    }))}
                  />
                </PopoverField>
                <PopoverField label="Status">
                  <FilterSelect
                    value={filters.status}
                    onChange={(v) => set({ status: v })}
                    anyLabel="Any status"
                    options={(statuses.data?.results ?? []).map((s) => ({
                      value: s.id,
                      label: s.name,
                    }))}
                  />
                </PopoverField>
                <PopoverField label="Tag">
                  <FilterSelect
                    value={filters.tag}
                    onChange={(v) => set({ tag: v })}
                    anyLabel="Any tag"
                    options={(tags.data?.results ?? []).map((t) => ({
                      value: t.slug,
                      label: t.name,
                    }))}
                  />
                </PopoverField>
              </PopoverContent>
            </Popover>
          )}
          {!grouped && viewStyle !== "hierarchy" && (
          <LevelOrganiser
            roles={rolesInGraph}
            order={roleOrder}
            onChange={(o) => {
              setRoleOrder(o)
              dropAllPositions()
              setLayoutTick((t) => t + 1)
            }}
            bonds={roleBonds}
            onBonds={(b) => {
              setRoleBonds(b)
              // Bonding changes the tiers, so drop pinned coordinates and
              // relayout - same as reordering.
              dropAllPositions()
              setLayoutTick((t) => t + 1)
            }}
            distance={roleDistance}
            onDistance={(role, step) => {
              setRoleDistance({ ...roleDistance, [role]: step })
              dropAllPositions()
              setLayoutTick((t) => t + 1)
            }}
          />
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 text-xs"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Display
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-3 p-3">
              {viewStyle !== "hierarchy" && (
              <PopoverField label="Layout">
                <SegmentedTabs<"LR" | "TB">
                  value={direction}
                  onValueChange={(d) => {
                    setDirection(d)
                    // A saved LR layout doesn't fit TB - re-run the layout.
                    dropAllPositions()
                    setLayoutTick((t) => t + 1)
                  }}
                  items={[
                    { value: "LR", label: "Side-to-side" },
                    { value: "TB", label: "Tree" },
                  ]}
                />
              </PopoverField>
              )}
              <PopoverField label="Group by">
                <SegmentedTabs<GroupBy>
                  value={groupBy}
                  onValueChange={(v) => {
                    // Grouping starts from the whole estate: clear the focus
                    // and any group we had drilled into, in one navigation.
                    patch({
                      group: v === dflt.group ? undefined : v,
                      device: undefined,
                      depth: undefined,
                      ...(v !== "none" ? { site: "all", location: "all" } : {}),
                    })
                    clearSel()
                    dropAllPositions()
                  }}
                  items={[
                    { value: "none", label: "None" },
                    { value: "site", label: "Site" },
                    { value: "location", label: "Location" },
                  ]}
                />
              </PopoverField>
              {viewStyle === "stencil" && (
                <PopoverField label="Cables">
                  <SegmentedTabs<"routed" | "straight" | "curved">
                    value={edgeRouting}
                    onValueChange={setEdgeRouting}
                    items={[
                      { value: "routed", label: "Routed" },
                      { value: "straight", label: "Straight" },
                      { value: "curved", label: "Curved" },
                    ]}
                  />
                </PopoverField>
              )}
              <PopoverField label="Colour by">
                <Select
                  value={colorMode}
                  onValueChange={(v) => setColorMode(v as EdgeColorMode)}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cable">Cable color</SelectItem>
                    <SelectItem value="type">By type</SelectItem>
                    <SelectItem value="status">By status</SelectItem>
                    <SelectItem value="speed">By speed</SelectItem>
                    <SelectItem value="none">No color</SelectItem>
                  </SelectContent>
                </Select>
              </PopoverField>
              <FormCheckbox
                label="Bundle aggregates"
                checked={lagMode === "on"}
                onChange={(v) => setLagMode(v ? "on" : "off")}
                className="items-center pt-1"
              />
              <FormCheckbox
                label="Show patch panels"
                checked={!filters.collapse}
                onChange={(v) => set({ collapse: !v })}
                className="items-center pt-1"
              />
            </PopoverContent>
          </Popover>
          </>
          )}
        </div>
      </header>

      {/* Second bar: saved views + actions. Scrolls within itself on
          narrow screens (scrollbar hidden) instead of panning the page.
          The Logical view has its own toolbar - no saved views/PNG there. */}
      {!logical && (
      <div className="flex h-10 shrink-0 [scrollbar-width:none] items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden">
        <Select
          value={viewId}
          onValueChange={(v) => {
            // Back to the default map: dropping the view (and its overrides)
            // is enough - the settings fall back to the stored personal
            // defaults on their own.
            if (v === "none") {
              clearView()
              return
            }
            const view = views.data?.results.find((x) => x.id === v)
            if (view) applyView(view)
          }}
        >
          <SelectTrigger className="h-7 w-44 shrink-0 text-xs">
            <SelectValue placeholder="Saved views" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No saved view</SelectItem>
            {(views.data?.results ?? []).map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {edited && (
          <Badge variant="secondary" className="shrink-0">
            edited
          </Badge>
        )}
        {viewId !== "none" && canChangeViews && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs whitespace-nowrap"
            onClick={() => save(viewId)}
            disabled={saveView.isPending || !docReady}
          >
            <Save className="h-3 w-3" /> {savingInPlace ? "Saving…" : "Save"}
          </Button>
        )}
        {canAddViews && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs whitespace-nowrap"
            onClick={() => openSaveAs()}
          >
            <Save className="h-3 w-3" /> Save as…
          </Button>
        )}
        {viewId !== "none" && canDeleteViews && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => deleteView.mutate(viewId)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <BarTip tip="Everything on this map">
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-7 text-xs",
                !showObjects && "text-muted-foreground"
              )}
              onClick={toggleObjects}
            >
              <PanelRight className="h-3 w-3" /> Objects
            </Button>
          </BarTip>
          <BarTip tip="Start a custom map">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-3 w-3" /> Add device
            </Button>
          </BarTip>
          <BarTip tip="Labelled box behind the cards">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={addZoneCentered}
            >
              <Square className="h-3 w-3" /> Zone
            </Button>
          </BarTip>
          <BarTip tip="Discard dragged positions">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setPositions(undefined)
                setLayoutTick((t) => t + 1)
              }}
            >
              <LayoutGrid className="h-3 w-3" /> Re-layout
            </Button>
          </BarTip>
          <BarTip tip="Copy a link to this map">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={copyLink}
            >
              <LinkIcon className="h-3 w-3" /> Link
            </Button>
          </BarTip>
          <BarTip tip="Whole map · Alt-click: visible area">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={(e) => exportPng(e.altKey)}
            >
              <Camera className="h-3 w-3" /> PNG
            </Button>
          </BarTip>
        </div>
      </div>

      )}

      <div className="flex min-h-0 flex-1">
      <div className="relative min-h-0 flex-1">
        {logical && <LogicalTopologyView />}
        {!logical && q.isLoading && (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        )}
        {!logical && q.isError && (
          <div className="p-6">
            <QueryError error={q.error} />
          </div>
        )}
        {!logical && graph && (
          <Suspense fallback={<Skeleton />}>
            <TopologyCanvas
              ref={canvas}
              graph={graph}
              colorMode={colorMode}
              direction={direction}
              roleOrder={roleOrder}
              roleBonds={roleBonds}
              roleDistance={roleDistance}
              edgeRouting={edgeRouting}
              nodeStyle={viewStyle}
              bundleLags={lagMode === "on"}
              positions={positions}
              layoutTick={layoutTick}
              fitKey={graphKey}
              matchedIds={matchedIds}
              selectedEdgeId={selEdgeId}
              onGhostEdge={setGhost}
              onBgpEdge={(d) => {
                const id = d.sessions?.[0]
                if (id) nav({ to: "/bgp-sessions/$id", params: { id } })
              }}
              onSelectNode={(d) => {
                clearSel()
                setSelNode(d)
              }}
              onSelectEdge={(d, id) => {
                clearSel()
                setSelEdge(d)
                setSelEdgeId(id)
              }}
              onSelectBundle={(cables, id) => {
                clearSel()
                setSelBundle(cables)
                setSelEdgeId(id)
              }}
              onSelectGroup={(d) => {
                clearSel()
                setSelGroup(d)
              }}
              onSelectGroupEdge={(d, id) => {
                clearSel()
                setSelGroupEdge(d)
                setSelEdgeId(id)
              }}
              onDrillGroup={drillInto}
              onOpenDevice={(id) =>
                nav({ to: "/devices/$id", params: { id } })
              }
              zones={zones}
              onZonesChange={setZones}
              onNodeContext={(node, x, y) => {
                if (node.type === "zone")
                  setMenu({ x, y, zoneId: node.id.slice(5) })
                else if (node.type === "sitegroup")
                  setMenu({ x, y, group: node.data as unknown as TopoGroupData })
                else if (node.type === "device" || node.type === "flat")
                  setMenu({
                    x,
                    y,
                    node: node.data as TopoNode["data"],
                    nodeId: node.id,
                  })
              }}
              onPaneContext={(x, y, fx, fy) => setMenu({ x, y, fx, fy })}
              onCanvasClick={clearSel}
              onDragEnd={() => {
                const p = canvas.current?.positions()
                if (!p) return
                // Keep the arrangement in-session (so an incidental rebuild -
                // colour/search - doesn't snap cards back) and, on the default
                // view, persist it across reloads. Saved views persist via Save.
                setPositions(p)
              }}
            />
          </Suspense>
        )}

        {!showObjects && (
          <HiddenChip
            count={hiddenHere}
            onShowAll={() => setHiddenNodes(NO_TOPO_HIDDEN)}
          />
        )}

        {graph && viewStyle === "hierarchy" && count > 60 && !hintDismissed && (
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm">
            <span className="text-muted-foreground">
              Hierarchy suits smaller maps - Wiring scales better here.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setViewStyle("stencil")}
            >
              Switch
            </Button>
            <button
              onClick={() => setHintDismissed(true)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {graph && viewStyle === "stencil" && !grouped && count > 80 && !hintDismissed && (
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm">
            <span className="text-muted-foreground">
              Large graph - the Flat view reads better at this size.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setViewStyle("flat")}
            >
              Switch
            </Button>
            <button
              onClick={() => setHintDismissed(true)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {!logical && graph && (
          // left-16 clears React Flow's zoom controls in the corner.
          <div className="absolute bottom-4 left-16 z-10">
            <CanvasLegend
              viewStyle={viewStyle}
              grouped={grouped}
              colorMode={colorMode}
              types={presentTypes}
            />
          </div>
        )}
        {selNode && (
          <NodePanel
            data={selNode}
            onClose={() => setSelNode(null)}
            onFocus={(id) => {
              setFocus({ id, depth: 1 })
              setSelNode(null)
            }}
          />
        )}
        {selEdge && (
          <EdgePanel data={selEdge} onClose={() => setSelEdge(null)} />
        )}
        {selBundle && (
          <BundlePanel cables={selBundle} onClose={() => setSelBundle(null)} />
        )}
        {selGroup && (
          <GroupPanel
            data={selGroup}
            onClose={() => setSelGroup(null)}
            onDrill={drillInto}
          />
        )}
        {selGroupEdge && (
          <GroupEdgePanel
            data={selGroupEdge}
            onClose={() => setSelGroupEdge(null)}
          />
        )}
      </div>

      {showObjects && !logical && graph && (
        <TopologyObjectsSidebar
          graph={fullGraph!}
          checks={checks}
          zones={zones}
          hidden={hidden}
          onHiddenChange={setHiddenNodes}
          selectedDeviceId={selNode?.device_id ?? null}
          selectedGroupId={selGroup?.group_id ?? null}
          selectedEdgeId={selEdgeId}
          onPickNode={(n) => {
            canvas.current?.focusNode(n.id)
            canvas.current?.selectNode(n.id)
            clearSel()
            setSelNode(n.data)
          }}
          onPickGroup={(n) => {
            canvas.current?.focusNode(n.id)
            canvas.current?.selectNode(n.id)
            clearSel()
            setSelGroup(n.data as unknown as TopoGroupData)
          }}
          onDrillGroup={drillInto}
          onPickEdge={(e) => {
            canvas.current?.focusEdge(e.id)
            clearSel()
            if (e.data) setSelEdge(e.data)
            setSelEdgeId(e.id)
          }}
          onFocusZone={(z) => canvas.current?.focusZone(z)}
          onRenameZone={(id, label) =>
            setZones(
              (zones ?? []).map((z) => (z.id === id ? { ...z, label } : z))
            )
          }
        />
      )}
      </div>

      {menu && (
        <>
          <div
            className="fixed inset-0 z-[999]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="fixed z-[1000] w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            style={{
              left: Math.min(menu.x, window.innerWidth - 240),
              top: Math.min(menu.y, window.innerHeight - 220),
            }}
          >
            {menu.node && (
              <>
                {menu.node.device_id && (
                  <MenuItem
                    onClick={() => {
                      setMenu(null)
                      nav({
                        to: "/devices/$id",
                        params: { id: menu.node!.device_id! },
                      })
                    }}
                  >
                    Open device
                  </MenuItem>
                )}
                {menu.node.device_id && (
                  <MenuItem
                    onClick={() => {
                      setMenu(null)
                      patch({
                        devices: undefined,
                        device: menu.node!.device_id!,
                        depth: undefined,
                      })
                    }}
                  >
                    Focus here (1 hop)
                  </MenuItem>
                )}
                {builder && menu.node.device_id && (
                  <MenuItem
                    onClick={() => {
                      setMenu(null)
                      void addNeighbors(menu.node!.device_id!)
                    }}
                  >
                    Add connected devices
                  </MenuItem>
                )}
                {builder && menu.node.device_id && (
                  <MenuItem
                    onClick={() => {
                      setMenu(null)
                      setCustom(
                        custom?.filter((x) => x !== menu.node!.device_id) ??
                          custom
                      )
                    }}
                  >
                    Remove from map
                  </MenuItem>
                )}
                {!builder && menu.node.device_id && (
                  <MenuItem
                    onClick={() => {
                      setMenu(null)
                      // One navigation: leaving focus and seeding the builder
                      // are the same transition.
                      patch({
                        device: undefined,
                        depth: undefined,
                        devices: menu.node!.device_id!,
                      })
                    }}
                  >
                    Start custom map here
                  </MenuItem>
                )}
                {menu.nodeId && (
                  <MenuItem
                    onClick={() => {
                      const id = menu.nodeId!
                      setMenu(null)
                      setHiddenNodes(withHidden(hidden, "devices", id, true))
                    }}
                  >
                    Remove from view
                  </MenuItem>
                )}
              </>
            )}
            {menu.zoneId && (
              <>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  {ZONE_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        recolorZone(menu.zoneId!, c)
                        setMenu(null)
                      }}
                      aria-label={`Colour this zone ${c}`}
                      className="size-4 rounded-sm border border-border"
                      style={{ background: c }}
                    />
                  ))}
                </div>
                <MenuItem
                  onClick={() => {
                    const id = menu.zoneId!
                    setMenu(null)
                    removeZone(id)
                  }}
                >
                  Delete zone
                </MenuItem>
              </>
            )}
            {menu.group && (
              <MenuItem
                onClick={() => {
                  setMenu(null)
                  drillInto(menu.group!)
                }}
              >
                Open group
              </MenuItem>
            )}
            {!menu.node && !menu.group && !menu.zoneId && (
              <>
                <MenuItem
                  onClick={() => {
                    setMenu(null)
                    setAddOpen(true)
                  }}
                >
                  Add device…
                </MenuItem>
                {!logical && (
                  <MenuItem
                    onClick={() => {
                      const { fx, fy } = menu
                      setMenu(null)
                      addZone(fx ?? 0, fy ?? 0)
                    }}
                  >
                    Add zone
                  </MenuItem>
                )}
                {builder && (
                  <MenuItem
                    onClick={() => {
                      setMenu(null)
                      exitBuilder()
                    }}
                  >
                    Exit custom map
                  </MenuItem>
                )}
              </>
            )}
          </div>
        </>
      )}

      <AddDeviceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        excludeIds={custom ?? undefined}
        onPick={(id) => addToCustom([id])}
      />
      <MaterializeCableDialog ghost={ghost} onClose={() => setGhost(null)} />
      <SaveAsDialog
        key={saveAsSeed.n}
        defaultName={saveAsSeed.name}
        open={saveAsOpen}
        onOpenChange={setSaveAsOpen}
        onSave={(name) => save(undefined, name)}
        busy={saveView.isPending}
      />
      <StaleViewDialog
        open={stale}
        name={appliedView?.name ?? ""}
        canCopy={canAddViews}
        reloading={reloading}
        onOpenChange={setStale}
        onSaveCopy={() => {
          setStale(false)
          openSaveAs(`${appliedView?.name ?? "View"} (copy)`)
        }}
        onReload={() => void reloadView()}
      />

      {/* The leave guard's one dialog. The router holds the navigation open
          until this resolves, so every close path must settle it: leave the
          blocker hanging and the next navigation is stuck behind it. */}
      <AlertDialog
        open={leaveGuard.status === "blocked"}
        onOpenChange={(open) => {
          // Escape, an overlay click and "Keep editing" all mean stay.
          if (!open) leaveGuard.reset?.()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This map has unsaved changes. Leaving it drops them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            {/* Radix closes on action too, so onOpenChange's reset() lands
                right after this proceed(). Both settle the same promise and
                only the first wins, so the navigation still goes through. */}
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

// ─── Detail panels ───────────────────────────────────────────────────────────

function PanelShell({
  title,
  onClose,
  children,
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="absolute top-3 right-3 z-10 w-80 rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-auto p-3 text-[12px]">
        {children}
      </div>
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  )
}

function NodePanel({
  data: d,
  onClose,
  onFocus,
}: {
  data: TopoNode["data"]
  onClose: () => void
  onFocus: (deviceId: string) => void
}) {
  return (
    <PanelShell
      title={<span className="font-mono">{d.name}</span>}
      onClose={onClose}
    >
      <div className="space-y-0.5">
        {d.role && (
          <Row label="Role">
            <ColorBadge name={d.role.name} color={d.role.color || undefined} />
          </Row>
        )}
        {d.status_display && <Row label="Status">{d.status_display}</Row>}
        {d.device_type && <Row label="Type">{d.device_type}</Row>}
        {d.site && (
          <Row label="Site">
            {d.site}
            {d.location ? ` · ${d.location}` : ""}
          </Row>
        )}
        {d.primary_ip && (
          <Row label="IP">
            <span className="font-mono">{d.primary_ip}</span>
          </Row>
        )}
        <Row label="Cabled ports">
          <span className="num">
            {d.ports?.length ?? 0} / {d.interface_count ?? 0}
          </span>
        </Row>
      </div>
      <div className="mt-3 flex gap-2">
        {d.device_id && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-xs"
              asChild
            >
              <Link to="/devices/$id" params={{ id: d.device_id }}>
                Open device
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-xs"
              onClick={() => onFocus(d.device_id!)}
            >
              <Crosshair className="h-3 w-3" /> Focus
            </Button>
          </>
        )}
      </div>
    </PanelShell>
  )
}

function EdgePanel({
  data: d,
  onClose,
}: {
  data: NonNullable<TopoEdge["data"]>
  onClose: () => void
}) {
  return (
    <PanelShell
      title={
        d.cable_label || (d.cable_numid ? `Cable #${d.cable_numid}` : "Cable")
      }
      onClose={onClose}
    >
      <div className="space-y-0.5">
        {d.cable_type && (
          <Row label="Type">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: typeColor(d.cable_type) }}
              />
              <span className="font-mono">{d.cable_type}</span>
            </span>
          </Row>
        )}
        {d.status && <Row label="Status">{d.status}</Row>}
        {d.length && (
          <Row label="Length">
            <span className="num">
              {d.length} {d.length_unit}
            </span>
          </Row>
        )}
        {d.speed && (
          <Row label="Speed">
            <span className="font-mono">{d.speed}</span>
          </Row>
        )}
        {!!d.via?.length && <Row label="Via">{d.via.join(", ")}</Row>}
      </div>
      {!!d.pairs?.length && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Connections
          </div>
          {d.pairs.map((p, i) => (
            // Full endpoint names, never clipped - wrap instead of truncate.
            <div
              key={i}
              className="py-0.5 font-mono text-[11px] leading-snug break-all"
            >
              <div>{p.a}</div>
              <div>↔ {p.b}</div>
            </div>
          ))}
        </div>
      )}
      {d.cable_id && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3 h-7 w-full text-xs"
          asChild
        >
          <Link to="/cables/$id" params={{ id: d.cable_id }}>
            Open cable
          </Link>
        </Button>
      )}
    </PanelShell>
  )
}

/** One row of the right-click context menu. */
function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
    >
      {children}
    </button>
  )
}

/** Device picker for the custom-map builder's + button. */
/**
 * Add a device to the map.
 *
 * The shared `DevicePicker`, not a bare combobox: a flat list of every name
 * is unusable past a few hundred devices, and the advanced search behind it
 * filters on site, role, type, manufacturer, status and tag server-side -
 * which is exactly how someone finds the card they want to add.
 */
function AddDeviceDialog({
  open,
  onOpenChange,
  onPick,
  excludeIds,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (deviceId: string) => void
  /** Already on the map - offering them again just adds nothing. */
  excludeIds?: string[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add device to the map</DialogTitle>
        </DialogHeader>
        <DevicePicker
          label=""
          value={null}
          excludeIds={excludeIds}
          onChange={(v) => {
            if (!v) return
            onPick(v)
            onOpenChange(false)
          }}
          placeholder="Pick a device…"
        />
      </DialogContent>
    </Dialog>
  )
}

/** Grouped mode: a site/location card's summary + drill-in. */
function GroupPanel({
  data: d,
  onClose,
  onDrill,
}: {
  data: TopoGroupData
  onClose: () => void
  onDrill: (d: TopoGroupData) => void
}) {
  return (
    <PanelShell title={d.name} onClose={onClose}>
      <div className="space-y-0.5">
        <Row label="Grouped by">{d.kind}</Row>
        <Row label="Devices">
          <span className="num">{d.device_count}</span>
        </Row>
      </div>
      {d.roles.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Roles
          </div>
          {d.roles.map((r) => (
            <div key={r.name} className="flex items-center gap-1.5 py-0.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: r.color || "var(--border)" }}
              />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="num text-muted-foreground">{r.count}</span>
            </div>
          ))}
        </div>
      )}
      {d.group_id && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3 h-7 w-full text-xs"
          onClick={() => onDrill(d)}
        >
          <Crosshair className="h-3 w-3" /> Open group
        </Button>
      )}
    </PanelShell>
  )
}

/** Grouped mode: an aggregated inter-group link. */
function GroupEdgePanel({
  data: d,
  onClose,
}: {
  data: GroupEdgeInfo
  onClose: () => void
}) {
  return (
    <PanelShell
      title={`${d.cable_count} cable${d.cable_count === 1 ? "" : "s"}`}
      onClose={onClose}
    >
      {d.types.length > 0 ? (
        <div className="space-y-0.5">
          {d.types.map((t) => (
            <div key={t} className="flex items-center gap-1.5 py-0.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: typeColor(t) }}
              />
              <span className="font-mono">{t}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">No media types recorded.</p>
      )}
    </PanelShell>
  )
}

/** Flat view: the member cables of a bundled edge, each openable. */
/** "Po1 ⇄ Po10 · " when every cable in the bundle shares that pair. */
function lagTitle(cables: BundleMember[]): string {
  const lag = sharedLag(cables)
  return lag ? `${lag.a?.name} ⇄ ${lag.b?.name} · ` : ""
}

function BundlePanel({
  cables,
  onClose,
}: {
  cables: BundleMember[]
  onClose: () => void
}) {
  return (
    <PanelShell
      title={`${lagTitle(cables)}${cables.length} cable${cables.length === 1 ? "" : "s"}`}
      onClose={onClose}
    >
      <div className="space-y-1.5">
        {cables.map((c, i) => (
          <div
            key={c.cable_id ?? i}
            className="rounded-md border border-border px-2 py-1.5"
          >
            <div className="flex items-center gap-1.5">
              {c.cable_type && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: c.color || typeColor(c.cable_type) }}
                />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {c.cable_label ||
                  (c.cable_numid ? `Cable #${c.cable_numid}` : "Cable")}
              </span>
              {(c.cable_type || c.speed) && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {[c.cable_type, c.speed].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
            {!!c.pairs?.length && (
              <div className="mt-1 space-y-1">
                {c.pairs.map((p2, j) => (
                  // Every pair, full names, wrapped - never clipped.
                  <div
                    key={j}
                    className="font-mono text-[10px] leading-snug break-all"
                  >
                    <div>{p2.a}</div>
                    <div>↔ {p2.b}</div>
                  </div>
                ))}
              </div>
            )}
            {c.cable_id && (
              <Button
                size="sm"
                variant="outline"
                className="mt-1.5 h-6 w-full text-[11px]"
                asChild
              >
                <Link to="/cables/$id" params={{ id: c.cable_id }}>
                  Open cable
                </Link>
              </Button>
            )}
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

function SaveAsDialog({
  open,
  onOpenChange,
  onSave,
  busy,
  defaultName = "",
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onSave: (name: string) => void
  busy: boolean
  /** Prefilled name ("Save as copy" offers "<view> (copy)"). */
  defaultName?: string
}) {
  const [name, setName] = useState(defaultName)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setName("")
        onOpenChange(o)
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) onSave(name.trim())
          }}
          className="grid gap-3"
        >
          <Input
            autoFocus
            placeholder="Core row · dc1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
