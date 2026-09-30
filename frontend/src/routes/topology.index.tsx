import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Building2,
  Cable,
  Cloud,
  CopyPlus,
  Crosshair,
  FilePlus,
  Globe,
  Link as LinkIcon,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  Save,
  Search,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
  Type,
  X,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { api, fetchTopology } from "@/lib/api"
import type {
  BulkStatusResponse,
  DevicePaletteRow,
  GhostEdgeData,
  Paginated,
  Status,
  TagOption,
  TopoEdge,
  TopoNode,
  TopologyGraph,
  TopologyDiagramDisplay,
  TopologyLinkOverride,
  TopologyQuery,
  TopologyViewNote,
  TopologyViewSaved,
  TopologyViewState,
  TopologyViewSummary,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { EmptyState } from "@/components/empty-state"
import {
  BarButton,
  BarIconButton,
  BarMenuTrigger,
  BarTip,
  BarToggle,
} from "@/components/map-toolbar"
import { LeaveGuardDialog } from "@/components/leave-guard-dialog"
import { Loading } from "@/components/loading"
import { InfoTip } from "@/components/ui/info-tip"
import { TruncatedText } from "@/components/ui/truncated-text"
import { FormCheckbox } from "@/components/forms"
import { ArrangeMenu } from "@/components/topology/arrange-menu"
import {
  HistoryButtons,
  HistoryMenuItems,
} from "@/components/topology/history-buttons"
import { useBarFit } from "@/components/topology/bar-fit"
import type { LevelsProps } from "@/components/topology/level-organiser"
import {
  PopoverField,
  TopologyFilters,
} from "@/components/topology/filters-popover"
import { CanvasLegend, legendRows } from "@/components/topology/legend"
import { PartialMapChip } from "@/components/topology/partial-map-chip"
import { ExportMenu } from "@/components/topology/export/export-menu"
import {
  ChassisMenuItems,
  DeviceMenuItems,
  EdgeMenuItems,
  GroupMenuItems,
  PaneMenuItems,
  RegionMenuItems,
  deviceMenuKeys,
  edgeMenuKeys,
  groupMenuKeys,
} from "@/components/topology/context-menu"
import type {
  CardFace,
  ChassisMenu,
  DeviceMenuProps,
  EdgeMenuProps,
} from "@/components/topology/context-menu"
import { PointerMenu } from "@/components/pointer-menu"
import {
  LogicalBar,
  LogicalDisplay,
  LogicalFilters,
  LogicalTopologyView,
} from "@/components/topology/logical-view"
import { TopologyObjectsSidebar } from "@/components/topology/map-sidebar"
import {
  BundlePanel,
  EdgePanel,
  GroupEdgePanel,
  GroupPanel,
  NodePanel,
} from "@/components/topology/detail-panels"
import {
  NO_TOPO_HIDDEN,
  applyHidden,
  hiddenOnMap,
  readTopoHidden,
  type TopoHidden,
} from "@/components/topology/hidden"
import { StaleViewDialog } from "@/components/topology/stale-view-dialog"
import {
  useDefaultView,
  useSetDefaultView,
} from "@/components/topology/default-view"
import {
  OVERRIDE_KEYS,
  overridesView,
} from "@/components/topology/view-overrides"
import {
  carryIntoDiagram,
  docFromView,
  emptyDocument,
  isMissingViewError,
  isRetiredStyle,
  isStaleViewError,
  lineOfRouting,
  readDefaultMap,
  RETIRED_STYLES,
  storedDefaultMap,
  toViewState,
  useDocumentKeys,
  useMapLeaveGuard,
  useViewDocument,
} from "@/components/topology/view-document"
import type {
  RetiredStyle,
  ViewDocument,
} from "@/components/topology/view-document"
import { retiredBox } from "@/components/topology/retired-box"
import { HiddenChip } from "@/components/hidden-chip"
import {
  setHidden as withHidden,
  useHideKeys,
} from "@/components/hidden-objects"
import { QueryError } from "@/components/query-error"
import { MaterializeCableDialog } from "@/components/topology/materialize-cable-dialog"
import {
  DevicePalette,
  PALETTE_QUERY_KEY,
} from "@/components/topology/device-palette"
import { NewViewDialog } from "@/components/topology/new-view-dialog"
import type { NewViewStart } from "@/components/topology/new-view-dialog"
import {
  NEW_CARD,
  boxAround,
  dropPlacement,
  placeNewcomers,
} from "@/components/topology/diagram/placement"
import type { Centre } from "@/components/topology/diagram/placement"
import { HIER_NEW_CARD } from "@/components/topology/layout"
import { useBands } from "@/components/topology/diagram/use-bands"
import {
  CHASSIS_MODES,
  chassisNodeId,
  chassisOrient,
  isChassisNode,
  vcOf,
} from "@/components/topology/diagram/chassis"
import type {
  ChassisLook,
  ChassisMode,
  ChassisOptions,
} from "@/components/topology/diagram/chassis"
import type { ChassisActions } from "@/components/topology/diagram/chassis-node"
import type { ChassisNodeData } from "@/components/topology/diagram/build-diagram"
import { isRow, isSide, titleStrip } from "@/components/topology/diagram/bands"
import type { BandBy } from "@/components/topology/diagram/bands"
import { NOTES_MAX, newNote } from "@/components/topology/diagram/notes"
import type { NoteIconName } from "@/components/topology/diagram/notes"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  CardLinesDialog,
  ViewCardLinesEditor,
} from "@/components/topology/diagram/card-lines-dialog"
import type { CardLinesTarget } from "@/components/topology/diagram/card-lines-dialog"
import {
  LineTabs,
  LinkLineRow,
  linkOverride,
} from "@/components/topology/diagram/line-tabs"
import { DEFAULT_LABELS } from "@/components/topology/diagram/link-labels"
import type { LabelToken } from "@/components/topology/diagram/link-labels"
import {
  anchorOf,
  canShowPhoto,
  faceOf,
  wantsPhotos,
  withFaces,
} from "@/components/topology/diagram/photo-anchors"
import type {
  BundleMember,
  CanvasHandle,
  EdgeColorMode,
  LineTarget,
  NodeStyle,
} from "@/components/topology/topology-canvas"
import type {
  DiagramCardData,
  DiagramLinkRef,
  Pt,
} from "@/components/topology/diagram/types"
import type {
  GroupEdgeInfo,
  TopoGroupData,
} from "@/components/topology/group-node"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { copyWithToast } from "@/lib/clipboard"
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
import { modKey } from "@/lib/mod-key"
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
 * on its default is written as no param at all, so a link stays short; a
 * bare `/topology` opens the tenant's default view (No view without one).
 * Anything unrecognised reads back as the default rather than breaking the
 * page - see `docs/features/topology.md` for the full table.
 */
export interface TopologySearch {
  /** The view tab - public names, not the internal node style. */
  tab?: TabStyle
  /** Applied saved view (`/api/topology-views/`), or `none` for No view.
   * Any other param present alongside a view is an override of it - the
   * toolbar says "Edited". */
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
  /** Diagram tab: Simple or Detailed cards. */
  mode?: DiagramModeParam
  /** Diagram tab: devices as cards or as their front photos. */
  face?: FaceParam
  /** Diagram tab: cables meet a photo's ports or its edge. */
  anchor?: AnchorParam
  /** Diagram tab: virtual chassis apart (`off`) or stacked top to bottom
   * (`v`) or left to right (`h`). */
  stack?: ChassisMode
  /** An unsaved hand-picked map's placed virtual chassis. */
  chassis?: string
  /** Diagram tab: the line type. */
  line?: LineParam
  /** Diagram tab: the labels on the links, comma-separated `subnet`, `ip`,
   * `port`. Present but empty = none. */
  labels?: string
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
    // Wiring and Flat retired into the Diagram: an old link opens it in the
    // mode that tab drew (the tab it named wins over a `mode` beside it).
    const retired = typeof s.tab === "string" ? RETIRED_TABS[s.tab] : undefined
    if (retired) {
      out.tab = "diagram"
      out.mode = retired
    }
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
    const mode = oneOf(s.mode, DIAGRAM_MODES)
    if (mode && !out.mode) out.mode = mode
    const face = oneOf(s.face, FACES)
    if (face) out.face = face
    const anchor = oneOf(s.anchor, ANCHORS)
    if (anchor) out.anchor = anchor
    const stack = oneOf(s.stack, CHASSIS_MODES)
    if (stack) out.stack = stack
    if (typeof s.chassis === "string" && s.chassis) out.chassis = s.chassis
    const line = oneOf(s.line, LINE_TYPES)
    if (line) out.line = line
    // …with the lines that tab drew, unless the link names one.
    const retiredStyle =
      typeof s.tab === "string" ? RETIRED_TAB_STYLE[s.tab] : undefined
    if (retiredStyle && !out.line)
      out.line = lineOfRouting(retiredStyle, s.cables)
    const depth = Number(s.depth)
    if (Number.isFinite(depth) && depth > 0)
      out.depth = Math.min(6, Math.round(depth))
    // "" is meaningful here (an empty builder map, no labels), so these
    // keep a present-but-empty string instead of dropping it.
    if (typeof s.devices === "string") out.devices = s.devices
    if (typeof s.labels === "string") out.labels = s.labels
    return out
  },
})

type Filters = {
  site: string
  role: string
  status: string
  tag: string
  collapse: boolean
}

/** A scope chip's X - the drill, hand-picked and focus chips. A plain
 * button: the Badge is too short for a Button. */
function ChipClose({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="ml-0.5 opacity-80 hover:opacity-100"
          onClick={onClick}
          aria-label={label}
        >
          <X className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" variant="default">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

// Dragged node positions for No view (no saved view), kept in the
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
// No view map is shaped, and a reload that forgot them would put back cards
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
// edge routing) for No view - like the dragged positions above,
// they must survive a reload. Saved views persist theirs via Save.
const DISPLAY_KEY = "danbyte-topology-display"
const SIDEBAR_KEY = "topology:sidebar"
/** Whether the Diagram's device list is open, per browser. */
const PALETTE_KEY = "topology:palette"
/** The Hierarchy tab's large-map hint was closed, per browser. */
const HINT_KEY = "topology:hierarchy-hint"
/** An unsaved map's device set rides in the URL, and the page's own
 * address has to fit a request line: past this many ids it is saved as a
 * view instead. */
const URL_SET_MAX = 200
/** A device's node id on the map. */
const devNode = (id: string) => `dev:${id}`
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
const VIEW_STYLES: ViewStyle[] = [
  "diagram",
  "stencil",
  "hierarchy",
  "flat",
  "logical",
]
/** Stored values may name a removed view (e.g. the scrapped Faceplates).
 * The style an arrangement is kept under: a view saved before styles were
 * recorded was arranged on Wiring (then the default). */
function sanitizeViewStyle(v: unknown): ViewStyle {
  return VIEW_STYLES.includes(v as ViewStyle) ? (v as ViewStyle) : "stencil"
}
/** The tabs. Wiring (the "stencil" renderer) and Flat are retired: a view
 * or link that names them opens the Diagram, Detailed or Simple. */
type TabStyle = "diagram" | "hierarchy" | "logical"
const TAB_STYLES = ["diagram", "hierarchy", "logical"] as const
/** Retired tab names a link may still carry, and the mode each opens. */
const RETIRED_TABS: Record<string, DiagramModeParam | undefined> = {
  wiring: "detailed",
  stencil: "detailed",
  flat: "simple",
}
/** The retired style each old tab name drew. */
const RETIRED_TAB_STYLE: Record<string, RetiredStyle | undefined> = {
  wiring: "stencil",
  stencil: "stencil",
  flat: "flat",
}
const COLOR_MODES = ["cable", "type", "status", "speed", "none"] as const
const DIRS = ["lr", "tb"] as const
/** Focus depths the hops select offers - all the URL and the API accept. */
const HOPS = [1, 2, 3, 4, 5, 6] as const
const ROUTINGS = ["routed", "straight", "curved"] as const
const LAG_MODES = ["on", "off"] as const
const GROUPS = ["none", "site", "location"] as const
/** The Diagram tab's switches: the card mode, the line type and the labels
 * the links carry. */
const DIAGRAM_MODES = ["simple", "detailed"] as const
/** Card | Photo: the view's default face; a device may override it. */
const FACES = ["card", "photo"] as const
/** Ports | Edge: where cables meet a photo; a device may override it. */
const ANCHORS = ["ports", "edge"] as const
const LINE_TYPES = ["straight", "elbow", "bendy", "cyclical"] as const
const LABEL_TOKENS: readonly LabelToken[] = ["subnet", "ip", "port"]
/** The known Labels tokens in `v`, in their own order; undefined for
 * anything that is not a list. */
const labelsOf = (v: unknown): LabelToken[] | undefined =>
  Array.isArray(v)
    ? LABEL_TOKENS.filter((t) => (v as unknown[]).includes(t))
    : undefined
type DiagramModeParam = (typeof DIAGRAM_MODES)[number]
type FaceParam = (typeof FACES)[number]
type AnchorParam = (typeof ANCHORS)[number]
type LineParam = (typeof LINE_TYPES)[number]
/** The tab a stored view style opens on. */
const tabOfStyle = (v: ViewStyle): TabStyle =>
  isRetiredStyle(v) ? "diagram" : v

/** What a saved view stores in `state.filters` - the map's settings under the
 * page's own names. Unchanged by the URL work: a view saved before it still
 * applies, and still supplies the fallback for anything the URL omits. */
/** The Diagram display a view saves, with how its virtual chassis draw. */
type DiagramDisplay = TopologyDiagramDisplay & { chassis?: ChassisMode }

/** A saved Diagram display's stacking, when it has one. */
const stackOf = (display: unknown) =>
  oneOf(
    (display as { chassis?: unknown } | null | undefined)?.chassis,
    CHASSIS_MODES
  )

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
    diagram: Partial<TopologyDiagramDisplay>
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

/** A topology query as the map it asks for: what the cards and links
 * carry (`include`, the card lines) left out. */
function mapKeyOf(q: TopologyQuery): string {
  const { include: _include, card_fields: _fields, ...map } = q
  return JSON.stringify(map)
}

/** One saved view, state included. */
const fetchView = (id: string) =>
  api<TopologyViewSaved>(`/api/topology-views/${id}/`)

// No view's whole document, in a saved view's `state` shape, so what a
// view saves beyond the arrangement - the Diagram's display, link and card
// overrides, notes - survives a reload here too. The positions, zones
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

/** No view's map as this browser last left it. A legacy single-map
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
  const { me, canDo, canManage } = useMe()
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
  // The tenant's default view: a bare /topology is replaced by it.
  const dv = useDefaultView(urlSearch, canDo("topologyview", "view"))
  /** A bare address about to become the default view's: nothing is
   * fetched or loaded for it. */
  const resolving = dv.resolving
  const viewId = urlSearch.view ?? "none"
  const viewQ = useQuery({
    queryKey: ["topology-view", viewId],
    queryFn: () => fetchView(viewId),
    enabled: viewId !== "none",
  })
  const appliedView = viewId !== "none" ? viewQ.data : undefined
  /** The view is gone: No view opens in its place (below). */
  const viewMissing =
    viewId !== "none" && viewQ.isError && isMissingViewError(viewQ.error)
  /** A saved view's settings have arrived (or failed to), and a bare
   * address has its view: until then the filters are the defaults, and the
   * map, its LLDP ghosts and its BGP sessions would be fetched for the
   * whole tenant. */
  const viewSettled =
    !resolving && (viewId === "none" || (viewQ.isFetched && !viewMissing))
  const vf = (appliedView?.state.filters ?? {}) as ViewFilters
  // This browser's No view settings from its last session there (this read
  // is unchanged from before the URL work - same hydration behaviour).
  const stored = useRef(readStoredDisplay()).current
  /** The style this browser's older, single arrangement was made on. */
  const legacyStyle = sanitizeViewStyle(stored.viewStyle)
  // No view's Diagram display, as this browser last saved it with
  // the map, and whether it has an arrangement (read once - the stored
  // map can be large).
  const [{ storedDiagram, storedArranged }] = useState(() => {
    const m = readStoredMap()
    return {
      storedDiagram: m?.filters.diagram,
      storedArranged: !!Object.keys(m?.positions.diagram ?? {}).length,
    }
  })

  // Value resolution for every control below:
  //   URL param → applied saved view → this browser's No view → hard default.
  // The hooks take the fallback as a plain value, so the chain is just this
  // object. "all" / "none" are spelled out rather than left absent, because a
  // link that turns a saved view's filter OFF has to say so - an absent param
  // would inherit the view's value again.
  // A view last shown on Wiring or Flat opens the Diagram in the mode
  // that tab drew; anything else not set opens Diagram, Detailed.
  const openedAs = vf.viewStyle ?? stored.viewStyle
  const dfltTab = tabOfStyle(sanitizeViewStyle(openedAs ?? "diagram"))
  const retiredMode = isRetiredStyle(openedAs)
    ? RETIRED_STYLES[openedAs]
    : undefined
  // …with the lines its cable routing gave it there, until it names its
  // own: a view's over this browser's Diagram default.
  const retiredLine = isRetiredStyle(openedAs)
    ? lineOfRouting(openedAs, vf.edgeRouting ?? stored.edgeRouting)
    : undefined
  const dfltFace =
    oneOf(vf.diagram?.face, FACES) ??
    oneOf(storedDiagram?.face, FACES) ??
    "card"
  // Photos are wide and short: a photo map reads best as rows stacked top
  // to bottom, like a rack. It opens in Tree unless its view saved a
  // layout or the link names one.
  const photoMap =
    (urlSearch.tab ?? dfltTab) === "diagram" &&
    (urlSearch.face ?? dfltFace) === "photo"
  const dirImplied = !vf.direction && !urlSearch.dir && photoMap
  const dflt = {
    tab: dfltTab,
    color: vf.colorMode ?? stored.colorMode ?? "cable",
    dir:
      (vf.direction ?? (photoMap ? "TB" : stored.direction) ?? "LR") === "TB"
        ? "tb"
        : "lr",
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
    mode:
      retiredMode ??
      oneOf(vf.diagram?.mode, DIAGRAM_MODES) ??
      oneOf(storedDiagram?.mode, DIAGRAM_MODES) ??
      "detailed",
    face: dfltFace,
    anchor:
      oneOf(vf.diagram?.photo_anchor, ANCHORS) ??
      oneOf(storedDiagram?.photo_anchor, ANCHORS) ??
      "ports",
    line:
      oneOf(vf.diagram?.line, LINE_TYPES) ??
      (isRetiredStyle(vf.viewStyle) ? retiredLine : undefined) ??
      oneOf(storedDiagram?.line, LINE_TYPES) ??
      retiredLine ??
      "straight",
    labels:
      labelsOf(vf.diagram?.labels) ??
      labelsOf(storedDiagram?.labels) ?? [...DEFAULT_LABELS],
    // Virtual chassis stack on a map not arranged by hand yet; a map
    // arranged before stacks keeps its arrangement until they are turned
    // on. Resolved once and saved with the display from then on.
    stack:
      stackOf(vf.diagram) ??
      stackOf(storedDiagram) ??
      ((
        viewId !== "none"
          ? !!Object.keys(appliedView?.state.positions_by_style?.diagram ?? {})
              .length
          : storedArranged
      )
        ? "off"
        : "v"),
  } as const

  const [tab, setTab] = useUrlEnum<TabStyle>("tab", dflt.tab, TAB_STYLES)
  const viewStyle: ViewStyle = tab
  const [colorMode, setColorMode] = useUrlEnum<EdgeColorMode>(
    "color",
    dflt.color,
    COLOR_MODES
  )
  const [dirParam, setDirParam] = useUrlEnum("dir", dflt.dir, DIRS)
  const direction: "LR" | "TB" = dirParam === "tb" ? "TB" : "LR"
  const setDirection = (d: "LR" | "TB") => setDirParam(d === "TB" ? "tb" : "lr")
  // The retired Wiring tab's cable routing ("routed" bends cables around
  // cards). No control sets it now; a view still saves the value it had.
  const [edgeRouting] = useUrlEnum("cables", dflt.cables, ROUTINGS)
  const [lagMode, setLagMode] = useUrlEnum(
    "lag",
    oneOf(vf.lag, LAG_MODES) ?? "on",
    LAG_MODES
  )
  const [diagramMode, setDiagramMode] = useUrlEnum<DiagramModeParam>(
    "mode",
    dflt.mode,
    DIAGRAM_MODES
  )
  const [diagramFace, setDiagramFace] = useUrlEnum<FaceParam>(
    "face",
    dflt.face,
    FACES
  )
  const [diagramAnchor, setDiagramAnchor] = useUrlEnum<AnchorParam>(
    "anchor",
    dflt.anchor,
    ANCHORS
  )
  const [diagramLine, setDiagramLine] = useUrlEnum<LineParam>(
    "line",
    dflt.line,
    LINE_TYPES
  )
  const [stackMode, setStackMode] = useUrlEnum<ChassisMode>(
    "stack",
    dflt.stack,
    CHASSIS_MODES
  )
  // Which labels the links carry. One stable array per value, so the
  // canvas rebuilds only when it changes.
  const [labelsCsv, setLabelsCsv] = useUrlCsv("labels", dflt.labels)
  const labelsKey = (labelsOf(labelsCsv) ?? dflt.labels).join(",")
  const diagramLabels = useMemo(
    () => (labelsKey ? (labelsKey.split(",") as LabelToken[]) : []),
    [labelsKey]
  )
  const setLabel = (token: LabelToken, on: boolean) =>
    setLabelsCsv(
      LABEL_TOKENS.filter((t) => (t === token ? on : diagramLabels.includes(t)))
    )
  const isDiagram = viewStyle === "diagram"
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
  // A hand-picked device set - a map built by hand. An unsaved one lives in
  // the URL (`devices=`); a saved view keeps its set in its document (below),
  // so adding and removing devices is undoable and saved with the view.
  const [urlDevices, setUrlDevices] = useUrlCsv("devices")
  const urlSetKey = urlDevices?.join(",") ?? null
  // What of the second bar gives way to its More menu, measured from the
  // bar as drawn: Copy link, then Objects, then Undo and Redo.
  const [barRef, barRoom] = useBarFit()
  /** The legend in the canvas's corner: a fit keeps the map clear of it. */
  const legendBox = useRef<HTMLDivElement>(null)
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
    /** A line: a cable, a bundle, an LLDP neighbour, a BGP session. */
    line?: LineTarget
    /** A virtual chassis' stack (its frame). */
    stack?: ChassisNodeData
  } | null>(null)
  // The camera shows a part of a map too large to open whole.
  const [partialMap, setPartialMap] = useState(false)
  // The device whose own card lines the "Card lines…" dialog edits.
  const [cardLinesFor, setCardLinesFor] = useState<CardLinesTarget | null>(null)
  const [search, setSearch] = useUrlText("q", "", { replace: true })
  const [focusId] = useUrlText("device")
  const [focusDepth, setFocusDepth] = useUrlInt("depth", 1, { min: 1, max: 6 })
  const focus = focusId ? { id: focusId, depth: focusDepth } : null
  /** Focus: this device's neighbourhood from the whole estate, one hop out
   * - from its menu and from its panel alike. */
  const focusDevice = (id: string) =>
    patch({ devices: undefined, device: id, depth: undefined })
  const setFocus = (f: { id: string; depth: number } | null) =>
    patch({
      device: f ? f.id : undefined,
      depth: f && f.depth !== 1 ? String(f.depth) : undefined,
    })
  // Which map is on screen. A saved view carries its own arrangement, zones
  // and hidden set; No view keeps its own in this browser; a custom map is
  // a scratch map until it is saved, so what you draw on it must not follow
  // you back to No view when you exit.
  const mapKey =
    viewId !== "none"
      ? `view:${viewId}`
      : urlDevices !== null
        ? "custom"
        : "default"

  // Everything about this map that is not in the URL - the arrangements,
  // zones, hidden set, overrides - as one undoable document. A saved view's
  // arrives with the view (the load effect below); No view starts from this
  // browser's copy.
  const doc = useViewDocument(() => {
    if (viewId !== "none") return { doc: emptyDocument(), key: mapKey }
    // On the way to the default view: a blank document under a key of its
    // own, so No view's copy in this browser is neither shown nor written.
    if (resolving) return { doc: emptyDocument(), key: "resolving" }
    if (urlDevices !== null)
      return { doc: emptyDocument({ devices: urlDevices }), key: mapKey }
    return { doc: defaultDocument(legacyStyle), key: mapKey }
  })
  const { dispatch: send, dirtyRef } = doc
  /** The saved view's own document is on screen, not the blank one shown
   * while it loads. */
  const viewDocReady =
    viewId !== "none" && doc.docKey === mapKey && doc.base !== null
  /** The hand-picked set on screen; null = the filters decide. A view's
   * comes from its document once that has loaded (before, from the view as
   * fetched); an unsaved map's from the URL. */
  const custom: string[] | null =
    viewId === "none"
      ? urlDevices
      : (urlDevices ?? (viewDocReady ? doc.doc.devices : (vf.devices ?? null)))
  const builder = custom !== null
  const customKey = custom?.join(",") ?? null

  /** The Diagram display a view saves: the URL's switches over what else
   * the view keeps (card face, labels, its own card lines). */
  const savedDiagram = doc.doc.filters.diagram
  const diagramDisplay = useMemo<DiagramDisplay>(
    () => ({
      face: diagramFace,
      labels: diagramLabels,
      ...(savedDiagram?.fields !== undefined
        ? { fields: savedDiagram.fields }
        : {}),
      mode: diagramMode,
      line: diagramLine,
      ...(diagramAnchor === "edge" ? { photo_anchor: diagramAnchor } : {}),
      chassis: stackMode,
    }),
    [
      savedDiagram,
      diagramMode,
      diagramFace,
      diagramLine,
      diagramLabels,
      diagramAnchor,
      stackMode,
    ]
  )
  /** A view gains the Diagram display once the Diagram tab is used on it. */
  const withDiagram = isDiagram || !!savedDiagram
  /** One user action = one undo step, however many edits it makes (a zone
   * drag also snapshots the cards). */
  const edit = (action: Parameters<typeof send>[0]) =>
    send(action, { coalesce: "gesture" })
  /** The view's own card lines (Display popover); null inherits. An undo
   * step like any other edit, and the cards refetch with the new list. */
  // Virtual chassis drawn as stacks: the view's stacking, each chassis'
  // own look (a document edit, one undo step), and on a hand-picked map
  // the chassis placed on it.
  const looksKey = JSON.stringify(doc.doc.chassisLooks)
  const chassisOpts = useMemo<ChassisOptions | undefined>(
    () =>
      isDiagram
        ? {
            mode: stackMode,
            looks: JSON.parse(looksKey) as Record<string, ChassisLook>,
          }
        : undefined,
    [isDiagram, stackMode, looksKey]
  )
  const setChassisLook = (vc: string, value: ChassisLook | null) =>
    edit({ type: "setChassisLook", id: vc, value })
  const chassisActions: ChassisActions = {
    onOrient: (vc, orient) => setChassisLook(vc, { orient }),
    onUnstack: (vc) => setChassisLook(vc, { off: true }),
  }
  const setViewCardLines = (fields: string[] | null) => {
    const next: TopologyDiagramDisplay = { ...diagramDisplay }
    delete next.fields
    if (fields) next.fields = fields
    edit({ type: "setDisplay", patch: { diagram: next } })
  }

  // One arrangement per view style - see PosByStyle. The canvas only ever
  // sees the style it is currently drawing.
  const positions = logical ? undefined : doc.doc.positions[viewStyle]
  /** Every style's arrangement is stale - the map is about to hold a
   * different set of devices. */
  const dropAllPositions = () => edit({ type: "clearPositions" })

  // What is switched off on this map - by site, location, role, link family
  // (the sidebar's eyes) or one card by hand (Hide). Not a filter: a filter
  // says what kind of thing belongs, this says "not that one" - the last
  // mile of a diagram you are shaping for someone to read.
  const hidden = doc.doc.hidden
  const setHiddenNodes = (next: TopoHidden) =>
    edit({ type: "setHidden", hidden: next })
  // Labelled backdrop boxes, per view style - a box framing Diagram cards
  // is the wrong size around Hierarchy's.
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
  const recolorZone = (id: string, color: string | null) =>
    setZones((zones ?? []).map((z) => (z.id === id ? { ...z, color } : z)))
  /** A row's sides for its cables to other bands; undefined is Auto. */
  const setExits = (id: string, exits: Zone["exits"]) =>
    setZones(
      (zones ?? []).map((z) => {
        if (z.id !== id) return z
        const { exits: _was, ...rest } = z
        return exits ? { ...rest, exits } : rest
      })
    )

  // Notes (diagram/notes.ts): one list per map, on the Diagram only.
  const notes = isDiagram ? doc.doc.notes : undefined
  const setNotes = (next: TopologyViewNote[]) =>
    edit({ type: "setNotes", notes: next })
  /** The note just added, which opens in its editor. Handed to the canvas
   * for the one render that adds it, so a later remount never reopens it. */
  const [freshNote, setFreshNote] = useState<string | null>(null)
  useEffect(() => {
    if (freshNote) setFreshNote(null)
  }, [freshNote])
  /** The Add menu leaves the focus in the new note's editor instead of
   * handing it back to its button, which would close the editor. */
  const noteFocus = useRef(false)
  const keepNoteFocus = (e: Event) => {
    if (noteFocus.current) e.preventDefault()
    noteFocus.current = false
  }
  const notesFull = doc.doc.notes.length >= NOTES_MAX
  /** A note in the middle of the screen, or where the menu was opened. */
  const addNote = (
    icon: NoteIconName | null,
    at?: { x: number; y: number }
  ) => {
    if (notesFull) return
    // In the middle of the screen: clear of the cards, the rows' titles and
    // the side bands there. Where the menu was opened: there.
    const drawn = at ? [] : (canvas.current?.regions() ?? [])
    const n = newNote(
      doc.doc.notes,
      `n${Date.now().toString(36)}`,
      icon ? { kind: "icon", icon } : { kind: "text" },
      at ?? canvas.current?.center() ?? { x: 0, y: 0 },
      at
        ? []
        : [
            ...Object.values(canvas.current?.boxes() ?? {}),
            ...drawn.filter(isRow).map(titleStrip),
            ...drawn.filter(isSide),
          ]
    )
    setNotes([...doc.doc.notes, n])
    setFreshNote(n.id)
    noteFocus.current = true
  }

  const [layoutTick, setLayoutTick] = useState(0)

  // The ONE place a map's document is (re)loaded. An effect, because a map
  // arrives several ways - picked in the select, opened as a link in a fresh
  // tab, refetched, left for No view - and the first fix that only covered
  // the click left cold links opening with No view's coordinates pinned
  // under the view's graph. A saved view's key carries
  // its `updated_at`: a newer copy (someone else saved) replaces a clean
  // document, but never unsaved edits - their Save reports the conflict.
  const loadedKey = useRef<string>(
    viewId !== "none" || resolving ? `${mapKey}@pending` : mapKey
  )
  useEffect(() => {
    // On the way to the default view nothing loads. The map left behind is
    // loaded afresh if the address comes back to it - the sidebar's
    // Topology on the default view itself, after Discard.
    if (resolving) {
      loadedKey.current = "resolving"
      return
    }
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
      doc.load(emptyDocument({ devices: urlDevices }), mapKey)
    } else {
      doc.load(defaultDocument(legacyStyle), mapKey)
    }
    loadedKey.current = key
    setLayoutTick((t) => t + 1)
    // Keyed on the map and the view copy only: the style and the document
    // are read as they are at that moment, not reasons to reload.
  }, [mapKey, appliedView, resolving])

  // An unsaved map's set is its URL. When the URL changes under the map
  // (Back, an edited link) the document follows, so undo and Save see the
  // set on screen; the page's own edits change both at once.
  const lastUrlSet = useRef(urlSetKey)
  useEffect(() => {
    if (lastUrlSet.current === urlSetKey) return
    lastUrlSet.current = urlSetKey
    if (viewId !== "none" || urlDevices === null) return
    if (doc.docKey !== "custom") return
    if ((doc.doc.devices?.join(",") ?? null) === urlSetKey) return
    send({ type: "replace", doc: { ...doc.doc, devices: urlDevices } })
  }, [urlSetKey])
  // A saved view keeps its set in its document; a link from before that
  // may still carry `devices=` beside `view=`. Read it once, as an edit.
  useEffect(() => {
    if (!viewDocReady || urlDevices === null) return
    send(
      { type: "replace", doc: { ...doc.doc, devices: urlDevices } },
      { coalesce: "gesture" }
    )
    patch({ devices: undefined }, { replace: true })
  }, [viewDocReady, urlSetKey])

  // No view persists to this browser as it changes; a saved view's
  // document is written by Save. Keyed on the document's own map, so the
  // frame between leaving a view and loading No view can never write the
  // view's arrangement into No view's storage.
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
    if (!ownDefault) return
    writeStoredMap(
      withDiagram
        ? {
            ...docNow,
            filters: { ...docNow.filters, diagram: diagramDisplay },
          }
        : docNow
    )
  }, [ownDefault, docNow, withDiagram, diagramDisplay])
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [ghost, setGhost] = useState<GhostEdgeData | null>(null)
  const [selNode, setSelNode] = useState<TopoNode["data"] | null>(null)
  const [selEdge, setSelEdge] = useState<NonNullable<TopoEdge["data"]> | null>(
    null
  )
  const [selBundle, setSelBundle] = useState<BundleMember[] | null>(null)
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null)
  /** The Diagram link behind the open cable or bundle panel. */
  const [selLink, setSelLink] = useState<DiagramLinkRef | null>(null)
  const [selGroup, setSelGroup] = useState<TopoGroupData | null>(null)
  const [selGroupEdge, setSelGroupEdge] = useState<GroupEdgeInfo | null>(null)
  // The Hierarchy tab's large-map hint, once closed, stays closed here.
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "closed"
    } catch {
      return false
    }
  })
  const dismissHint = () => {
    setHintDismissed(true)
    try {
      localStorage.setItem(HINT_KEY, "closed")
    } catch {
      /* private mode - non-fatal */
    }
  }
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
    setSelLink(null)
  }
  /** The open panel's link, as the view draws it. */
  const lineRow =
    isDiagram && selLink ? (
      <LinkLineRow
        link={selLink}
        override={doc.doc.links[selLink.pairKey]}
        viewLine={diagramLine}
        onChange={(v) => setLinkOverride(selLink.pairKey, v)}
      />
    ) : null
  /** A link's own line (and arc side) in the view; empty = the view's. */
  const setLinkOverride = (key: string, value: TopologyLinkOverride) =>
    edit({ type: "setLink", key, value: linkOverride(value) })

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

  /** Leaving the builder. A saved view whose whole point IS its device set
   * can't survive losing it, so that view is left behind too; a filter view
   * built on by hand goes back to its filters. The map the user lands on
   * brings its own arrangement (the load effect), and a view built on by
   * hand keeps the positions of the cards it still shows. */
  const exitBuilder = () => {
    if (viewId !== "none" && !vf.devices && viewDocReady)
      edit({ type: "replace", doc: { ...doc.doc, devices: null } })
    patch({ devices: undefined, ...(vf.devices ? { view: dv.noView } : {}) })
    clearSel()
  }

  /** A filter change writes its params in ONE navigation (separate setters in
   * the same tick would overwrite each other) and drops hand-tuned positions,
   * since the map is about to hold different devices. An applied saved view
   * stays applied - the change rides on top of it as an override, which is
   * what the toolbar's "Edited" reports. */
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

  // Persist No view's display settings across reloads. Only while no saved
  // view is selected - a saved view's settings belong to that view.
  useEffect(() => {
    if (viewId !== "none" || resolving) return
    writeStoredDisplay({
      colorMode,
      // A photo map's own Tree is not the card map's choice.
      direction: dirImplied ? stored.direction : direction,
      roleOrder,
      roleBonds,
      roleDistance,
      edgeRouting,
      viewStyle,
      groupBy,
    })
  }, [
    viewId,
    resolving,
    colorMode,
    direction,
    dirImplied,
    stored,
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
      api<Paginated<{ id: string; name: string; color?: string | null }>>(
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
  // The cards - the Diagram's, and the Hierarchy's headers - ask for their
  // lines (`include=card`), under the view's own list when it has one.
  const cardFields = savedDiagram?.fields
  const cardFieldsKey = cardFields ? cardFields.join(",") : null
  // The links' subnets and addresses (`include=link_ips`) only when a
  // label shows them.
  const linkIps =
    diagramLabels.includes("subnet") || diagramLabels.includes("ip")
  // Front photos (`include=photo`) only when some device shows its photo.
  const photos = wantsPhotos(diagramFace, doc.doc.nodes)
  const graphQuery = useMemo<TopologyQuery>(() => {
    const collapse_panels = filters.collapse
    const cards: Partial<TopologyQuery> = !grouped
      ? {
          include: [
            "card",
            ...(isDiagram && linkIps ? (["link_ips"] as const) : []),
            ...(isDiagram && photos ? (["photo"] as const) : []),
          ],
          ...(cardFieldsKey !== null
            ? { card_fields: cardFieldsKey ? cardFieldsKey.split(",") : [] }
            : {}),
        }
      : {}
    // Builder mode: exactly this set, nothing else.
    if (custom !== null) return { devices: custom, collapse_panels, ...cards }
    if (focus && !grouped)
      return { device: focus.id, depth: focus.depth, collapse_panels, ...cards }
    const g: TopologyQuery = { collapse_panels, ...cards }
    if (filters.site !== "all") g.site = filters.site
    if (filters.role !== "all") g.role = filters.role
    if (filters.status !== "all") g.status = filters.status
    if (filters.tag !== "all") g.tag = filters.tag
    if (grouped) g.group_by = groupBy
    // Drilled into a group: the device view scoped to that one group. Its
    // id is already on the matching filter param, so nothing extra here.
    if (drill && drill.kind === "location") g.location = drill.id
    return g
  }, [
    filters,
    focus,
    grouped,
    groupBy,
    drill,
    custom,
    isDiagram,
    cardFieldsKey,
    linkIps,
    photos,
  ])
  /** Changes exactly when the map does - the canvas refits on a new one.
   * What the cards and links carry (`include`, the card lines) is not a
   * new map. */
  const graphKey = useMemo(() => mapKeyOf(graphQuery), [graphQuery])
  /** A map built by hand is the same map however its set grows or shrinks:
   * adding a device must not refit the camera or blank the canvas. */
  const setKey =
    custom !== null
      ? `set:${viewId === "none" ? "scratch" : viewId}:${
          filters.collapse ? 1 : 0
        }`
      : null
  const fitKey = setKey ?? graphKey

  const q = useQuery({
    queryKey: ["topology", graphQuery, setKey],
    queryFn: ({ signal }) => fetchTopology(graphQuery, { signal }),
    enabled: !logical && viewSettled,
    // The same map asked for with other labels or card lines - or a hand-
    // built map with a device more or less - keeps the one on screen until
    // the new one arrives, instead of blanking it.
    placeholderData: (prev, prevQuery) =>
      prevQuery &&
      (mapKeyOf(prevQuery.queryKey[1] as TopologyQuery) === graphKey ||
        (setKey !== null && prevQuery.queryKey[2] === setKey))
        ? prev
        : undefined,
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
      // A virtual chassis' stack is seen with its members.
      seen: q.data?.nodes.flatMap((n) => {
        const vc = vcOf(n.data)
        return vc ? [n.id, chassisNodeId(vc.id)] : [n.id]
      }),
    })
  }

  // ── Wiring and Flat, retired ──
  // A map last shown on the Wiring or Flat tab opens on the Diagram. The
  // first time it does with no Diagram arrangement of its own, that tab's
  // arrangement and zones come across (carryIntoDiagram); once the canvas
  // has drawn them at the Diagram's card sizes, the cards that now overlap
  // move apart (`onSpread`). Both are one undo step, and the map is edited:
  // a view waits for Save, No view keeps it as it goes.
  const carryStyle =
    mapKey === "custom"
      ? undefined
      : viewId !== "none"
        ? vf.viewStyle
        : stored.viewStyle
  /** The document (its load key) whose carried cards the canvas spreads. */
  const [carrying, setCarrying] = useState<string | null>(null)
  const carriedFor = useRef<string | null>(null)
  const carryReady = viewId !== "none" ? viewDocReady : doc.docKey === mapKey
  /** This map's own graph, not the last one kept on screen meanwhile. */
  const ownGraph = q.isPlaceholderData ? undefined : q.data
  useEffect(() => {
    if (!isDiagram || !isRetiredStyle(carryStyle)) return
    if (!carryReady || !ownGraph) return
    // Once per document as loaded: undoing the carry must not redo it.
    const key = loadedKey.current
    if (carriedFor.current === key) return
    carriedFor.current = key
    const data = new Map(ownGraph.nodes.map((n) => [n.id, n.data]))
    const next = carryIntoDiagram(doc.doc, carryStyle, (id) =>
      retiredBox(carryStyle, data.get(id), direction)
    )
    if (!next) return
    send({ type: "replace", doc: next }, { step: `carry:${key}` })
    setCarrying(key)
    setLayoutTick((t) => t + 1)
  }, [isDiagram, carryStyle, carryReady, ownGraph])
  /** The carried cards as the canvas spread them: kept in the carry's own
   * undo step, beside the cards it did not draw (hidden ones). */
  const onSpread = (centres: PosMap) => {
    const key = carrying
    setCarrying(null)
    if (!key || !positions) return
    send(
      {
        type: "setPositions",
        style: "diagram",
        positions: { ...positions, ...centres },
      },
      { step: `carry:${key}` }
    )
  }
  const spreadFrom =
    isDiagram && carrying !== null && carrying === loadedKey.current
      ? positions
      : undefined

  const ghosts = useQuery({
    queryKey: ["topology-ghosts", filters.site],
    enabled: !logical && viewSettled,
    queryFn: ({ signal }) =>
      api<{ edges: TopoEdge[] }>(
        `/api/monitoring/topology/ghosts/${
          filters.site !== "all" ? `?site=${filters.site}` : ""
        }`,
        { signal }
      ),
  })

  const bgp = useQuery({
    queryKey: ["topology-bgp", filters.site],
    enabled: !logical && viewSettled,
    queryFn: ({ signal }) =>
      api<{ edges: TopoEdge[] }>(
        `/api/routing/topology/bgp/${
          filters.site !== "all" ? `?site=${filters.site}` : ""
        }`,
        { signal }
      ),
  })

  /** Everything the query returned plus the LLDP ghosts and BGP sessions
   * between those cards - what the sidebar lists, hidden or not. */
  const fullGraph = useMemo<TopologyGraph | undefined>(() => {
    // On the way to the default view, not the last map kept for this key.
    if (!q.data || resolving) return undefined
    const present = new Set(q.data.nodes.map((n) => n.id))
    const between = (e: TopoEdge) =>
      present.has(e.source) && present.has(e.target)
    const ghostEdges = (ghosts.data?.edges ?? []).filter(between)
    const bgpEdges = (bgp.data?.edges ?? []).filter(between)
    return { ...q.data, edges: [...q.data.edges, ...ghostEdges, ...bgpEdges] }
  }, [q.data, ghosts.data, bgp.data, resolving])
  // Each device's own Card | Photo and Ports | Edge, over the view's.
  const nodeFaces = doc.doc.nodes
  /** A Diagram card's face for its menu. The items are named for what is
   * drawn; a pick keeps the device's own face and anchor only where they
   * differ from the view's. */
  const cardFace = (n: TopoNode["data"], id: string): CardFace => {
    const photo = !!(n as Partial<DiagramCardData>).diagram?.photo
    const setOwn = (change: { face?: FaceParam; anchor?: AnchorParam }) => {
      const own = { ...nodeFaces[id], ...change }
      if (own.face === diagramFace) delete own.face
      if (own.anchor === diagramAnchor) delete own.anchor
      edit({ type: "setNode", id, value: own.face || own.anchor ? own : null })
    }
    const anchor = anchorOf(id, diagramAnchor, nodeFaces)
    const next = photo ? "card" : "photo"
    return {
      photo,
      // A type with no photo or faceplate is drawn as its card either way.
      canPhoto: canShowPhoto(n) !== false,
      anchor,
      onFace: () => {
        if (faceOf(id, diagramFace, nodeFaces) !== next) setOwn({ face: next })
      },
      onAnchor: () => setOwn({ anchor: anchor === "edge" ? "ports" : "edge" }),
    }
  }
  /** What the canvas draws. How many cards hiding took off THIS map is the
   * chip's count - a view saved against one filter can carry names the
   * current query never returns, and offering to restore those would be a
   * lie. The Diagram marks the devices it shows as their photos. */
  const graph = useMemo(
    () =>
      fullGraph
        ? withFaces(
            applyHidden(fullGraph, hidden),
            isDiagram ? diagramFace : "card",
            isDiagram ? nodeFaces : undefined,
            diagramAnchor
          )
        : undefined,
    [fullGraph, hidden, isDiagram, diagramFace, nodeFaces, diagramAnchor]
  )
  const hiddenHere = fullGraph ? hiddenOnMap(fullGraph, hidden) : 0
  // The view's own Card | Photo lays an automatic map out again and
  // refits the camera - once the map asked for with it has arrived, so it
  // is laid out once, with the photos. A device's own face, or photos
  // arriving, do neither: the canvas keeps the camera and the centres and
  // moves only what a photo now covers.
  const [shownFace, setShownFace] = useState(diagramFace)
  if (shownFace !== diagramFace && q.data && !q.isPlaceholderData)
    setShownFace(diagramFace)

  // Media types on the map - the legend swatches them in type color mode.
  const presentTypes = useMemo(() => {
    const s = new Set<string>()
    for (const e of graph?.edges ?? [])
      if (e.data?.cable_type) s.add(e.data.cable_type)
    return [...s].sort()
  }, [graph])

  // The Diagram's layer bands (diagram/bands.ts): Arrange writes the bands
  // and the cards it moved as one undo step, like every band edit that
  // carries cards.
  const bandLevels = useMemo(
    () => ({ order: roleOrder, bonds: roleBonds }),
    [roleOrder, roleBonds]
  )
  const bands = useBands({
    regions: isDiagram ? zones : undefined,
    setRegions: setZones,
    setPositions: (p) => setPositions(p),
    canvas,
    nodes: graph?.nodes,
    levels: bandLevels,
    direction,
  })
  /** Arrange or Clear waiting on "replace the bands drawn by hand?". */
  const [bandAsk, setBandAsk] = useState<{ by: BandBy | null } | null>(null)
  const arrangeBands = (by: BandBy) => {
    if (bands.handRows) setBandAsk({ by })
    else bands.arrange(by)
  }
  const clearBands = () => {
    if (bands.handBands) setBandAsk({ by: null })
    else bands.clear()
  }

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

  /** Hide lines one by one (their menu's Hide, or H on a selected one):
   * the payload edges they draw, as the Objects sidebar's cable rows
   * would. */
  const hideLines = (ids: readonly string[]) => {
    const add = ids.filter((id) => !hidden.edges.includes(id))
    if (add.length)
      setHiddenNodes({ ...hidden, edges: [...hidden.edges, ...add] })
    clearSel()
  }

  // H hides the selected card or line (or, when grouped, the selected site
  // or location) as its eye would; Shift+H shows all.
  const selNodeId = selNode?.device_id ? `dev:${selNode.device_id}` : null
  useHideKeys(
    !logical && selNodeId
      ? () => {
          setHiddenNodes(withHidden(hidden, "devices", selNodeId, true))
          clearSel()
        }
      : !logical && selEdgeId
        ? () => {
            const line = canvas.current?.line(selEdgeId)
            if (line) hideLines(line.edgeIds)
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
  const cardMonitor = !!q.data?.meta?.card?.uses_monitor
  const monQuery = useQuery({
    queryKey: ["device-mon-status", deviceIds],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ devices: deviceIds }),
      }),
    // The sidebar's chips, and the cards' pill when some card lists
    // `monitor`.
    enabled: !logical && deviceIds.length > 0 && (showObjects || cardMonitor),
    staleTime: 30_000,
  })
  const checks = monQuery.data?.statuses ?? EMPTY_MON

  // ── Saved views ──
  // Save needs `change` on the view; Save as (and Ctrl+S on a map that is
  // not a view yet) needs `add`.
  const canChangeViews = canDo("topologyview", "change")
  const canAddViews = canDo("topologyview", "add")
  const canDeleteViews = canDo("topologyview", "delete")
  // The default view: tenant admins, or the set_default grant (whose row
  // limits the server applies).
  const canSetDefault = canManage || canDo("topologyview", "set_default")
  const isDefault = viewId !== "none" && viewId === dv.defaultId
  const setDefault = useSetDefaultView(
    (id) => views.data?.results.find((v) => v.id === id)?.name
  )
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

  /** Back to No view, with no overrides - `view=none` once the tenant has a
   * default view, since the bare address opens that. */
  const clearView = () => patch({ view: dv.noView, ...noOverrides() })

  // A view that is gone - deleted since the link was made, or another
  // tenant's - is said once, and No view opens in its place instead of the
  // whole tenant drawn under a blank select. In place: Back skips it.
  // Always `none`: a default still cached as that view can't send the page
  // straight back to it. Not past the leave guard: a view deleted elsewhere
  // while it was being edited is found on a refetch, and its unsaved edits
  // are asked about first, so Keep editing can still Save as… a new view.
  useEffect(() => {
    if (!viewMissing) return
    toast.error("View not found")
    void qc.invalidateQueries({ queryKey: ["topology-views"] })
    patch({ view: "none", ...noOverrides() }, { replace: true })
  }, [viewMissing])

  /** The applied view is no longer what it saved - the URL carries at least
   * one override on top of `?view=` (the Find box aside), or the map itself
   * was edited. */
  const edited =
    viewId !== "none" &&
    (doc.dirty || overridesView(urlSearch))
  /** A view's own document is on screen (not the blank one shown while it
   * loads) - saving before that would write an empty map over it. */
  const docReady =
    !resolving &&
    (viewId === "none" || (doc.docKey === mapKey && doc.base !== null))

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
        ...(withDiagram ? { diagram: diagramDisplay } : {}),
      },
      devices: custom,
      style: viewStyle,
    })

  const [stale, setStale] = useState(false)
  const [reloading, setReloading] = useState(false)
  // A fresh dialog per opening, so the stale-view dialog's Save as… can
  // hand it a name.
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

  /** Delete asks first: a view holds a diagram built by hand. */
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteView = useMutation({
    mutationFn: (a: { id: string; name?: string }) =>
      api<void>(`/api/topology-views/${a.id}/`, { method: "DELETE" }),
    onSuccess: (_, a) => {
      setConfirmDelete(false)
      qc.invalidateQueries({ queryKey: ["topology-views"] })
      // Nothing is left to keep the edits in, so there is nothing for the
      // leave guard to ask; No view loads on the way out.
      doc.load(emptyDocument(), mapKey)
      clearView()
      toast.success(a.name ? `Deleted “${a.name}”` : "View deleted")
    },
    onError: (err) => apiErrorToast(err),
  })

  // ── Building a map by hand ──
  // The device list (Diagram and Hierarchy tabs) and New view. Cards added
  // by hand get a position on the tab before the map is fetched again, so
  // the build pins them where they were put; until they arrive they are
  // drawn muted.
  const [paletteOpen, setPaletteOpen] = useState(() => {
    try {
      return localStorage.getItem(PALETTE_KEY) === "open"
    } catch {
      return false
    }
  })
  const setPalette = (open: boolean) => {
    setPaletteOpen(open)
    try {
      localStorage.setItem(PALETTE_KEY, open ? "open" : "closed")
    } catch {
      /* private mode - non-fatal */
    }
  }
  const paletteShown = !logical && paletteOpen
  /** A map whose set is picked by hand takes dropped devices. */
  const canBuild = !logical && builder
  /** Where a card added by hand is kept: the tab's own arrangement. A
   * Diagram card stands on its centre, a Hierarchy card on its top-left
   * corner; each is its tab's new-card size until the map fetches it. */
  const placeStyle = isDiagram ? ("diagram" as const) : ("hierarchy" as const)
  const newCard = isDiagram ? NEW_CARD : HIER_NEW_CARD
  /** A new card's position from the middle of its box. */
  const placeAt = ([x, y]: Centre): [number, number] =>
    isDiagram ? [x, y] : [x - newCard.w / 2, y - newCard.h / 2]
  /** Where the next device added from the list lands (a right-click on
   * the canvas); null = the middle of the screen. */
  const [addAt, setAddAt] = useState<Pt | null>(null)
  const [newViewOpen, setNewViewOpen] = useState(false)
  /** Devices added and not on the map yet: their names and role colours. */
  const [pending, setPending] = useState<
    ReadonlyMap<string, { name: string; color?: string | null }>
  >(() => new Map())
  /** Every device on the map, or in its set. */
  const placedIds = useMemo(
    () =>
      new Set(
        customKey !== null
          ? customKey.split(",").filter(Boolean)
          : (q.data?.nodes ?? [])
              .map((n) => n.data.device_id)
              .filter((x): x is string => !!x)
      ),
    [customKey, q.data]
  )
  const pendingCards = useMemo(() => {
    if (!pending.size) return []
    const present = new Set((q.data?.nodes ?? []).map((n) => n.id))
    const pos = doc.doc.positions[placeStyle] ?? {}
    return [...pending].flatMap(([id, info]) => {
      const key = devNode(id)
      if (present.has(key) || !(key in pos)) return []
      const [x, y] = pos[key]
      const at: [number, number] = isDiagram
        ? [x, y]
        : [x + newCard.w / 2, y + newCard.h / 2]
      return [
        { id: key, name: info.name, color: info.color, at, size: newCard },
      ]
    })
  }, [pending, q.data, doc.doc.positions, placeStyle, isDiagram, newCard])
  // Once the map is fetched with them, the added devices are either on it
  // or out of this user's sight - they stay in the set either way (another
  // user may see them).
  useEffect(() => {
    if (!pending.size || !q.data || q.isPlaceholderData || q.isFetching) return
    const inSet = new Set(customKey?.split(",") ?? [])
    const ids = [...pending.keys()]
    if (!ids.every((id) => inSet.has(id))) return
    const present = new Set(q.data.nodes.map((n) => n.data.device_id))
    const missing = ids.filter((id) => !present.has(id)).length
    if (missing)
      toast.error(
        missing === 1
          ? "1 device can't be shown on this map"
          : `${missing} devices can't be shown on this map`
      )
    setPending(new Map())
  }, [pending, q.data, q.isPlaceholderData, q.isFetching, customKey])

  /**
   * Devices join the hand-picked set - with `place`, their positions on
   * the tab on screen, in the same undo step. A view's set is in its document; an
   * unsaved map's in the URL as well (the document follows it for undo).
   * On a map that follows its filters this starts a set of just `ids`, as
   * the older tabs' Add device always has. False when nothing was added.
   */
  const addToSet = (ids: string[], place?: PosMap): boolean => {
    const have = custom ?? []
    const fresh = ids.filter((id) => !have.includes(id))
    if (!fresh.length) return false
    const next = [...have, ...fresh]
    const placed = place ? { style: placeStyle, place } : {}
    if (viewId !== "none") {
      // Not before the view's own document is on screen: the load would
      // throw the edit away.
      if (!viewDocReady) return false
      edit({ type: "addDevices", ids: fresh, ...placed })
      return true
    }
    if (next.length > URL_SET_MAX) {
      toast.error(`An unsaved map holds up to ${URL_SET_MAX} devices`, {
        description: "Save it as a view to add more.",
        ...(canAddViews
          ? { action: { label: "Save as…", onClick: () => openSaveAs() } }
          : {}),
      })
      return false
    }
    if (custom !== null) edit({ type: "addDevices", ids: fresh, ...placed })
    setUrlDevices(next)
    return true
  }
  /** Devices leave the hand-picked set, with their positions and
   * overrides - one undo step. */
  const removeFromSet = (ids: string[]) => {
    if (custom === null || !ids.length) return
    if (viewId !== "none") {
      if (viewDocReady) edit({ type: "removeDevices", ids })
      return
    }
    edit({ type: "removeDevices", ids })
    setUrlDevices(custom.filter((id) => !ids.includes(id)))
  }
  /** "Start hand-picked map": the map shrinks to this one device. */
  const startSetAt = (id: string) => {
    if (viewId !== "none") {
      if (!viewDocReady) return
      edit({ type: "replace", doc: { ...doc.doc, devices: [id] } })
      patch({ device: undefined, depth: undefined })
      return
    }
    patch({ device: undefined, depth: undefined, devices: id })
  }
  /** Cards laid out automatically so far keep their place when a device
   * is added by hand: where they stand (a Diagram card's centre, a
   * Hierarchy card's corner), to pin with it. */
  const freezeLayout = (): PosMap => {
    const saved = doc.doc.positions[placeStyle] ?? {}
    const out: PosMap = {}
    for (const [id, b] of Object.entries(canvas.current?.boxes() ?? {}))
      if ((id.startsWith("dev:") || isChassisNode(id)) && !(id in saved))
        out[id] = isDiagram ? [b.x + b.w / 2, b.y + b.h / 2] : [b.x, b.y]
    return out
  }
  /** What a new card must not land on: the cards, and those on the way. */
  const occupied = () => [
    ...Object.values(canvas.current?.boxes() ?? {}),
    ...pendingCards.map((p) => boxAround({ x: p.at[0], y: p.at[1] }, newCard)),
  ]
  const markPending = (
    ids: string[],
    info: (id: string) => { name: string; color?: string | null }
  ) =>
    setPending((cur) => {
      const next = new Map(cur)
      for (const id of ids) next.set(id, info(id))
      return next
    })
  /** The palette's rows, as its query last loaded them. */
  const paletteRow = (id: string): DevicePaletteRow | undefined =>
    qc
      .getQueryData<Paginated<DevicePaletteRow>>(PALETTE_QUERY_KEY)
      ?.results.find((r) => r.id === id)
  /** Devices dropped on the map (or added from the list) at `at`. On the
   * Diagram a device lands in its band's row. */
  const dropDevices = (ids: string[], at: Pt) => {
    if (!canBuild) return
    const onMap = new Set(custom)
    const fresh = ids.filter((id) => !onMap.has(id))
    if (!fresh.length) return
    const centres = dropPlacement(fresh.map(devNode), at, occupied(), {
      size: newCard,
      ...(isDiagram
        ? {
            rowsAt: bands.rowsAt,
            ruleRow: (nid: string) => {
              const row = paletteRow(nid.slice(4))
              return bands.ruleRow({
                role: row?.role?.id,
                type: row?.device_type?.id,
              })
            },
          }
        : {}),
    })
    const place: PosMap = {}
    for (const [id, c] of Object.entries(centres)) place[id] = placeAt(c)
    // Placed among the bands as drawn: those are what gets saved.
    if (isDiagram) bands.keepDrawn()
    if (!addToSet(fresh, { ...freezeLayout(), ...place })) return
    markPending(fresh, (id) => {
      const row = paletteRow(id)
      return { name: row?.name ?? "…", color: row?.role?.color }
    })
  }
  const addFromList = (rows: DevicePaletteRow[]) => {
    const at = addAt ?? canvas.current?.center() ?? { x: 0, y: 0 }
    setAddAt(null)
    dropDevices(
      rows.map((r) => r.id),
      at
    )
  }
  /** Everything cabled to these devices joins the set - on the Diagram
   * placed next to what it is cabled to. */
  const addConnected = async (sources: string[]) => {
    if (!sources.length) return
    try {
      const graphs = await Promise.all(
        sources.map((id) =>
          fetchTopology({
            device: id,
            depth: 1,
            collapse_panels: filters.collapse,
          })
        )
      )
      const have = new Set(custom ?? [])
      const fresh = new Map<string, TopoNode>()
      for (const g of graphs)
        for (const n of g.nodes) {
          const id = n.data.device_id
          if (id && !have.has(id) && !fresh.has(id)) fresh.set(id, n)
        }
      if (!fresh.size) {
        toast("No new connected devices")
        return
      }
      const ids = [...fresh.keys()]
      // The Hierarchy ranks newcomers by their cabling: it lays them out.
      if (!canBuild || !isDiagram) {
        addToSet(ids)
        return
      }
      const boxes = canvas.current?.boxes() ?? {}
      const newNodes = new Set(ids.map(devNode))
      const near: Record<string, Pt[]> = {}
      // A stack member is where its stack is.
      const vcs = new Map(
        (graph?.nodes ?? []).flatMap((n) => {
          const vc = vcOf(n.data)
          return vc ? [[n.id, chassisNodeId(vc.id)] as const] : []
        })
      )
      for (const g of graphs)
        for (const e of g.edges)
          for (const [a, b0] of [
            [e.source, e.target],
            [e.target, e.source],
          ]) {
            const b = b0 in boxes ? b0 : (vcs.get(b0) ?? b0)
            if (!newNodes.has(a) || !(b in boxes)) continue
            const box = boxes[b]
            ;(near[a] ??= []).push({
              x: box.x + box.w / 2,
              y: box.y + box.h / 2,
            })
          }
      const place = placeNewcomers(ids.map(devNode), near, occupied(), {
        rowsAt: bands.rowsAt,
        ruleRow: (nid) => {
          const d = fresh.get(nid.slice(4))?.data
          return bands.ruleRow({ role: d?.role?.id, type: d?.device_type_id })
        },
      })
      bands.keepDrawn()
      if (!addToSet(ids, { ...freezeLayout(), ...place })) return
      markPending(ids, (id) => ({
        name: fresh.get(id)?.data.name ?? "…",
        color: fresh.get(id)?.data.role?.color,
      }))
      // Where they land may be off screen: bring them into view.
      canvas.current?.reveal(
        Object.values(place).map(([x, y]) => boxAround({ x, y }, NEW_CARD))
      )
    } catch (err) {
      apiErrorToast(err)
    }
  }
  /** The devices a building action works on: the selected cards. */
  const selectedDevices = () => {
    const ids = canvas.current?.selectedDevices() ?? []
    return ids.length ? ids : selNode?.device_id ? [selNode.device_id] : []
  }
  // Delete and Backspace take the selected notes off the Diagram, and the
  // selected cards off a map built by hand. React Flow's own delete key is
  // off (cards leave only on purpose).
  const deleteKey = useRef<(() => boolean) | null>(null)
  deleteKey.current = () => {
    const gone = notes?.length ? (canvas.current?.selectedNotes() ?? []) : []
    // With notes selected, only cards selected with them go - not the
    // card whose panel happens to be open.
    // Cards leave any hand-picked map this way, Diagram or Hierarchy - the
    // same maps their menu's Remove from map works on.
    const ids =
      !builder || logical
        ? []
        : gone.length
          ? (canvas.current?.selectedDevices() ?? [])
          : selectedDevices()
    if (!gone.length && !ids.length) return false
    if (gone.length) {
      const drop = new Set(gone)
      setNotes(doc.doc.notes.filter((n) => !drop.has(n.id)))
    }
    if (ids.length) {
      removeFromSet(ids)
      clearSel()
    }
    return true
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable ||
          t.closest(
            "[role=dialog],[role=alertdialog],[role=listbox],[role=menu]"
          ))
      )
        return
      if (deleteKey.current?.()) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  /** A new view's saved state: blank, or this map's devices as they stand
   * (on the Diagram, where they stand). */
  const newViewState = (start: NewViewStart): TopologyViewState => {
    const ids =
      start === "map"
        ? (graph?.nodes ?? [])
            .map((n) => n.data.device_id)
            .filter((x): x is string => !!x)
        : []
    const arranged: PosByStyle = {}
    if (start === "map" && isDiagram) {
      const at: PosMap = {}
      for (const [id, b] of Object.entries(canvas.current?.boxes() ?? {}))
        if (id.startsWith("dev:") || isChassisNode(id))
          at[id] = [b.x + b.w / 2, b.y + b.h / 2]
      arranged.diagram = at
    }
    return toViewState(emptyDocument({ devices: ids, positions: arranged }), {
      filters: {
        collapse: filters.collapse,
        colorMode,
        direction,
        roleOrder,
        roleBonds,
        roleDistance,
        edgeRouting,
        viewStyle: "diagram",
        groupBy: "none",
        lag: lagMode,
        diagram: diagramDisplay,
      },
      style: "diagram",
    })
  }

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
    // An unsaved map's set is in its URL too: it steps with the document.
    const toSet = to?.devices?.join(",")
    if (viewId === "none" && urlDevices !== null && toSet !== undefined)
      if (toSet !== urlSetKey) {
        lastUrlSet.current = toSet
        patch({ devices: toSet }, { replace: true })
      }
  }
  useDocumentKeys({
    enabled: !logical,
    onSave: saveShortcut,
    onUndo: () => stepHistory(true),
    onRedo: () => stepHistory(false),
  })
  /** The same steps from the second bar (a view's own document once it is
   * on screen). */
  const steps = {
    canUndo: docReady && doc.canUndo,
    canRedo: docReady && doc.canRedo,
    onUndo: () => stepHistory(true),
    onRedo: () => stepHistory(false),
  }

  // ── Unsaved-edit guard ──
  // See useMapLeaveGuard: another map (view, default, custom) is a leave, a
  // filter change on this one is not.
  const leaveGuard = useMapLeaveGuard(doc)

  /** This map, as a link someone else can open. */
  const copyLink = async () => {
    await copyWithToast(window.location.href, "Link copied")
  }

  // What an export says about this map: its name, the tenant, the filters
  // in words, and a link back.
  const named = (
    list: { id: string; name: string }[] | undefined,
    id: string
  ) => (id === "all" ? undefined : list?.find((x) => x.id === id)?.name)
  const siteName = named(sites.data?.results, siteF)
  const exportName = appliedView?.name ?? drill?.name ?? siteName ?? "Topology"
  const exportMeta = () => {
    const tag =
      tagF === "all"
        ? undefined
        : tags.data?.results.find((t) => t.slug === tagF)?.name
    const summary = [
      siteName && `Site ${siteName}`,
      named(roles.data?.results, roleF) &&
        `Role ${named(roles.data?.results, roleF)}`,
      named(statuses.data?.results, statusF) &&
        `Status ${named(statuses.data?.results, statusF)}`,
      tag && `Tag ${tag}`,
    ]
      .filter(Boolean)
      .join(" · ")
    return {
      title: exportName,
      ...(me.active_tenant ? { tenant: me.active_tenant.name } : {}),
      generated_at: new Date().toISOString(),
      ...(summary ? { filters: summary } : {}),
      danbyte_url: window.location.href,
    }
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
  /** The Arrange menu's "Levels…": reordering, bonding or spacing the
   * levels drops pinned coordinates and lays the map out again. */
  const relevel = () => {
    dropAllPositions()
    setLayoutTick((t) => t + 1)
  }
  const levelsProps: LevelsProps = {
    roles: rolesInGraph,
    order: roleOrder,
    onChange: (o) => {
      setRoleOrder(o)
      relevel()
    },
    bonds: roleBonds,
    onBonds: (b) => {
      setRoleBonds(b)
      relevel()
    },
    distance: roleDistance,
    onDistance: (role, step) => {
      setRoleDistance({ ...roleDistance, [role]: step })
      relevel()
    },
  }

  const count = q.data?.nodes.length ?? 0
  const focusName = focus
    ? (graph?.nodes.find((n) => n.data.device_id === focus.id)?.data.name ??
      "device")
    : null
  /** A view saved as a device set is that set: no chip of its own. */
  const handPickedChip = builder && !(viewId !== "none" && vf.devices)
  const scopeChip = !!drill || handPickedChip || !!focus
  // The header's widths (container px) below which Simple | Detailed moves
  // into More: a scope chip needs the room. Literal classes, for Tailwind.
  const headNarrow = scopeChip
    ? {
        hide: "@max-[1240px]/head:hidden",
        show: "@max-[1240px]/head:inline-flex",
        find: "@max-[1240px]/head:w-32",
      }
    : {
        hide: "@max-[900px]/head:hidden",
        show: "@max-[900px]/head:inline-flex",
        find: "@max-[1040px]/head:w-32",
      }
  /** A virtual chassis' items: on its stack, and on its members' cards.
   * `stacked` is how it is drawn now (null: apart); `members` its cards on
   * the map. */
  const chassisMenu = (
    vc: string,
    stacked: "v" | "h" | null,
    members: readonly string[]
  ): ChassisMenu => ({
    id: vc,
    orient: stacked,
    onOrient: (orient) => setChassisLook(vc, { orient }),
    onUnstack: () => setChassisLook(vc, { off: true }),
    ...(stacked && members.length
      ? {
          onHide: () =>
            setHiddenNodes(
              members.reduce(
                (h, id) => withHidden(h, "devices", id, true),
                hidden
              )
            ),
        }
      : {}),
  })
  /** A device card's right-click menu: its items and the keys they show
   * act on this card, not on the canvas selection. */
  const deviceMenu = (
    n: TopoNode["data"],
    nodeId: string | undefined
  ): DeviceMenuProps => {
    const id = n.device_id ?? null
    return {
      deviceId: id,
      builder,
      onFocus: () => id && focusDevice(id),
      onAddConnected: () => id && void addConnected([id]),
      onRemove: () => {
        if (!id) return
        removeFromSet([id])
        clearSel()
      },
      // One step: leaving focus and seeding the set are the same
      // transition.
      onStartSet: () => id && startSetAt(id),
      onHide: nodeId
        ? () => setHiddenNodes(withHidden(hidden, "devices", nodeId, true))
        : undefined,
      diagram:
        isDiagram && id
          ? {
              face: grouped ? undefined : cardFace(n, id),
              onCardLines: canDo("device", "change")
                ? () => setCardLinesFor({ id, name: n.name, role: n.role })
                : undefined,
              roleSlug: (canManage && n.role?.slug) || undefined,
              ...memberMenu(n),
            }
          : undefined,
    }
  }
  /** A card's Virtual chassis sub-menu, when it is a member of one. */
  const memberMenu = (n: TopoNode["data"]): { chassis?: ChassisMenu } => {
    const vc = vcOf(n)
    if (!vc || grouped) return {}
    const stack = (n as { chassis?: string }).chassis
    const orient = stack ? (chassisOrient(vc.id, chassisOpts) ?? "v") : null
    const members = stack
      ? (graph?.nodes ?? [])
          .filter((m) => vcOf(m.data)?.id === vc.id)
          .map((m) => m.id)
      : []
    return { chassis: chassisMenu(vc.id, orient, members) }
  }
  /** A site or location card's right-click menu. */
  const groupMenu = (g: TopoGroupData) => ({
    onOpen: () => drillInto(g),
    onHide: () =>
      setHiddenNodes(
        withHidden(
          hidden,
          g.kind === "site" ? "sites" : "locations",
          g.name,
          true
        )
      ),
  })
  /** A line's right-click menu: Open cable for one cable, its own line on
   * the Diagram (an undo step, like its panel's Line row), and Hide. */
  const lineMenu = (line: LineTarget): EdgeMenuProps => {
    const key = isDiagram ? line.link?.pairKey : undefined
    const own = key ? doc.doc.links[key] : undefined
    return {
      ...(line.cableId ? { cableId: line.cableId } : {}),
      ...(key
        ? {
            line: {
              value: own?.line ?? "default",
              onChange: (v) =>
                setLinkOverride(key, {
                  ...own,
                  line: v === "default" ? undefined : v,
                }),
            },
          }
        : {}),
      onHide: () => hideLines(line.edgeIds),
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Both bars fit a 1280px screen with the sidebar open: past the
          widths below, the header's Simple | Detailed and the second bar's
          Objects and Copy link move into a More menu. Anything narrower
          scrolls, with its scrollbar showing. */}
      <header className="@container/head flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6">
        <h1 className="shrink-0 text-base font-semibold">Topology</h1>
        {q.data && !logical && (
          // One width whatever the number, so the tabs after it stay put.
          <Badge variant="secondary" className="min-w-24 shrink-0">
            <span className="num">{count}</span>{" "}
            {grouped
              ? count === 1
                ? "group"
                : "groups"
              : count === 1
                ? "device"
                : "devices"}
          </Badge>
        )}
        <SegmentedTabs<TabStyle>
          value={tab}
          onValueChange={(v) => {
            // Each style keeps its OWN arrangement: switching away doesn't
            // discard it, and switching back restores it. The canvas treats
            // the style change itself as a relayout, so no tick here - a
            // tick fired now would land on the OUTGOING style (the style
            // rides on the URL, which updates a beat later).
            setTab(v)
          }}
          items={[
            { value: "diagram", label: "Diagram" },
            { value: "hierarchy", label: "Hierarchy" },
            { value: "logical", label: "Logical" },
          ]}
        />
        {isDiagram && (
          <div
            className={cn("flex shrink-0 items-center gap-2", headNarrow.hide)}
          >
            <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
            <SegmentedTabs<DiagramModeParam>
              value={diagramMode}
              onValueChange={setDiagramMode}
              items={[
                { value: "simple", label: "Simple" },
                { value: "detailed", label: "Detailed" },
              ]}
            />
          </div>
        )}
        {/* Scope chips follow the tabs, so the tabs never move. */}
        {drill && (
          <Badge variant="default" className="shrink-0 gap-1">
            <TruncatedText className="max-w-40">{drill.name}</TruncatedText>
            <ChipClose label="Back to groups" onClick={leaveDrill} />
          </Badge>
        )}
        {/* A view saved as a device set is that set: its name is in the
            views select and the count beside the title. */}
        {handPickedChip && (
          <Badge variant="default" className="shrink-0 gap-1">
            Hand-picked · <span className="num">{custom?.length ?? 0}</span>
            <ChipClose label="Back to filtered map" onClick={exitBuilder} />
          </Badge>
        )}
        {focus && (
          <Badge variant="default" className="shrink-0 gap-1">
            <Crosshair className="h-3 w-3" />
            <TruncatedText className="max-w-40">{focusName}</TruncatedText>
            {/* The hops select beside Find says how far; without it (a
                hand-picked map) the chip does. */}
            {builder && (
              <span className="whitespace-nowrap">
                · {focus.depth} hop{focus.depth === 1 ? "" : "s"}
              </span>
            )}
            <ChipClose label="Clear focus" onClick={() => setFocus(null)} />
          </Badge>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {logical && (
            <>
              <LogicalFilters />
              <LogicalDisplay />
            </>
          )}
          {!logical && (
            <>
              <InputGroup className={cn("h-7 w-40 shrink-0", headNarrow.find)}>
                <InputGroupAddon>
                  <Search className="size-3" />
                </InputGroupAddon>
                <InputGroupInput
                  placeholder="Find on map…"
                  aria-label="Find on map"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && matchedIds?.size)
                      canvas.current?.focusNode([...matchedIds][0])
                  }}
                  className="h-7 text-xs md:text-xs"
                />
              </InputGroup>
              {builder ? null : focus ? (
                <Select
                  value={String(focus.depth)}
                  onValueChange={(v) => setFocusDepth(Number(v))}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-24 text-xs data-[size=sm]:h-7"
                    aria-label="Hops"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOPS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d} hop{d === 1 ? "" : "s"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <TopologyFilters
                  value={filters}
                  onChange={set}
                  sites={sites.data?.results}
                  roles={roles.data?.results}
                  statuses={statuses.data?.results}
                  tags={tags.data?.results}
                />
              )}
              <Popover>
                <PopoverTrigger asChild>
                  <BarMenuTrigger>
                    <SlidersHorizontal /> Display
                  </BarMenuTrigger>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="max-h-(--radix-popover-content-available-height) w-64 space-y-3 overflow-y-auto p-3"
                >
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
                          ...(v !== "none"
                            ? { site: "all", location: "all" }
                            : {}),
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
                  {isDiagram && !grouped && (
                    <PopoverField label="Draw as">
                      <SegmentedTabs<FaceParam>
                        value={diagramFace}
                        onValueChange={setDiagramFace}
                        items={[
                          { value: "card", label: "Card" },
                          { value: "photo", label: "Photo" },
                        ]}
                      />
                    </PopoverField>
                  )}
                  {isDiagram && !grouped && photos && (
                    <PopoverField label="Cables to">
                      <SegmentedTabs<AnchorParam>
                        value={diagramAnchor}
                        onValueChange={setDiagramAnchor}
                        items={[
                          { value: "ports", label: "Ports" },
                          { value: "edge", label: "Edge" },
                        ]}
                      />
                    </PopoverField>
                  )}
                  {isDiagram && !grouped && (
                    <PopoverField label="Virtual chassis">
                      <SegmentedTabs<ChassisMode>
                        value={stackMode}
                        onValueChange={setStackMode}
                        items={[
                          { value: "off", label: "Off" },
                          { value: "v", label: "Top-down" },
                          { value: "h", label: "Left-right" },
                        ]}
                      />
                    </PopoverField>
                  )}
                  {isDiagram && (
                    <PopoverField label="Lines">
                      <LineTabs<LineParam>
                        value={diagramLine}
                        onChange={setDiagramLine}
                      />
                    </PopoverField>
                  )}
                  {isDiagram && !grouped && (
                    <PopoverField label="Labels">
                      <div className="flex items-center gap-4">
                        {(
                          [
                            ["subnet", "Subnets"],
                            ["ip", "IPs"],
                            ["port", "Ports"],
                          ] as const
                        ).map(([token, label]) => (
                          <FormCheckbox
                            key={token}
                            label={label}
                            checked={diagramLabels.includes(token)}
                            onChange={(v) => setLabel(token, v)}
                            className="items-center whitespace-nowrap"
                          />
                        ))}
                      </div>
                    </PopoverField>
                  )}
                  <PopoverField label="Color by">
                    <Select
                      value={colorMode}
                      onValueChange={(v) => setColorMode(v as EdgeColorMode)}
                    >
                      <SelectTrigger size="sm" className="w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cable">Cable</SelectItem>
                        <SelectItem value="type">Type</SelectItem>
                        <SelectItem value="status">Status</SelectItem>
                        <SelectItem value="speed">Speed</SelectItem>
                        <SelectItem value="none">None</SelectItem>
                      </SelectContent>
                    </Select>
                  </PopoverField>
                  <FormCheckbox
                    label="LAG bundles"
                    checked={lagMode === "on"}
                    onChange={(v) => setLagMode(v ? "on" : "off")}
                    className="items-center pt-1"
                  />
                  <FormCheckbox
                    label="Patch panels"
                    checked={!filters.collapse}
                    onChange={(v) => set({ collapse: !v })}
                    className="items-center pt-1"
                  />
                  {isDiagram && !grouped && (
                    <div className="border-t border-border pt-3">
                      <PopoverField label="Card lines">
                        <ViewCardLinesEditor
                          value={savedDiagram?.fields ?? null}
                          onChange={setViewCardLines}
                        />
                      </PopoverField>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              {isDiagram && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <BarIconButton
                      label="More"
                      className={cn("hidden", headNarrow.show)}
                    >
                      <MoreHorizontal />
                    </BarIconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuLabel>Diagram</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={diagramMode}
                      onValueChange={(v) =>
                        setDiagramMode(v as DiagramModeParam)
                      }
                    >
                      <DropdownMenuRadioItem value="simple">
                        Simple
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="detailed">
                        Detailed
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
        </div>
      </header>

      {/* Second bar: saved views + actions. The Logical tab has no saved
          views or exports: its bar is Copy link. */}
      {logical && <LogicalBar />}
      {!logical && (
        <div
          ref={barRef}
          className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6"
        >
          <BarToggle
            pressed={paletteShown}
            onClick={() => setPalette(!paletteOpen)}
          >
            <PanelLeft /> Devices
          </BarToggle>
          <Select
            value={resolving ? "" : viewId}
            onValueChange={(v) => {
              // Back to No view: dropping the view (and its overrides) is
              // enough - the settings fall back to this browser's own.
              if (v === "none") {
                clearView()
                return
              }
              const view = views.data?.results.find((x) => x.id === v)
              if (view) applyView(view)
            }}
          >
            <SelectTrigger
              size="sm"
              className={cn(
                "w-44 shrink-0 text-xs data-[size=sm]:h-7",
                barRoom.objects && "w-36"
              )}
              aria-label="Views"
            >
              <SelectValue placeholder="Views" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No view</SelectItem>
              {(views.data?.results ?? []).map((v) => (
                <SelectItem
                  key={v.id}
                  value={v.id}
                  aside={
                    v.id === dv.defaultId ? (
                      <Badge variant="secondary">Default</Badge>
                    ) : undefined
                  }
                >
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {viewId !== "none" && canSetDefault && (
            <BarIconButton
              label={isDefault ? "Clear default" : "Set as default"}
              disabled={setDefault.isPending || !appliedView}
              onClick={() => setDefault.mutate(isDefault ? null : viewId)}
            >
              <Star className={cn(isDefault && "fill-current")} />
            </BarIconButton>
          )}
          {canAddViews && (
            <BarIconButton
              label="New view"
              onClick={() => setNewViewOpen(true)}
            >
              <FilePlus />
            </BarIconButton>
          )}
          {edited && (
            <Badge variant="secondary" className="shrink-0">
              Edited
            </Badge>
          )}
          {viewId !== "none" && canChangeViews && (
            <BarTip tip="Save" shortcut={`${modKey()}S`}>
              <BarButton
                onClick={() => save(viewId)}
                disabled={saveView.isPending || !docReady}
              >
                <Save /> {savingInPlace ? "Saving…" : "Save"}
              </BarButton>
            </BarTip>
          )}
          {canAddViews && (
            <BarButton onClick={() => openSaveAs()}>
              <CopyPlus /> Save as…
            </BarButton>
          )}
          {viewId !== "none" && canDeleteViews && (
            <BarIconButton
              label="Delete view"
              destructive
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
            </BarIconButton>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!barRoom.objects && (
              <BarToggle
                pressed={showObjects}
                onClick={toggleObjects}
                data-bar-item="objects"
              >
                <PanelRight /> Objects
              </BarToggle>
            )}
            {!barRoom.history && (
              <div data-bar-item="history" className="flex items-center gap-2">
                <HistoryButtons {...steps} />
              </div>
            )}
            {isDiagram ? (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <BarMenuTrigger>
                      <Plus /> Add
                    </BarMenuTrigger>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-48"
                    onCloseAutoFocus={keepNoteFocus}
                  >
                    <DropdownMenuItem onSelect={() => setPalette(true)}>
                      <PanelLeft /> Devices…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canBuild || !selNode?.device_id}
                      onSelect={() => void addConnected(selectedDevices())}
                    >
                      <Cable /> Connected devices
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={bands.addRow}>
                      <RectangleHorizontal /> Band
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={bands.addSide}>
                      <RectangleVertical /> Side band
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={addZoneCentered}>
                      <Square /> Zone
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={notesFull}
                      onSelect={() => addNote(null)}
                    >
                      <Type /> Text
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={notesFull}
                      onSelect={() => addNote("cloud")}
                    >
                      <Cloud /> Cloud
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={notesFull}
                      onSelect={() => addNote("globe")}
                    >
                      <Globe /> Globe
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={notesFull}
                      onSelect={() => addNote("building")}
                    >
                      <Building2 /> Building
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ArrangeMenu
                  // Rows hold their cards: with rows Arrange made, a new
                  // layout arranges them again by what they were made
                  // from; rows drawn by hand are cleared first.
                  resetDisabled={bands.hasRows && !bands.ruleBy}
                  onReset={() => {
                    if (bands.ruleBy) {
                      arrangeBands(bands.ruleBy)
                      return
                    }
                    setPositions(undefined)
                    setLayoutTick((t) => t + 1)
                  }}
                  bands={{
                    onByRole: () => arrangeBands("role"),
                    onByType: () => arrangeBands("device_type"),
                    onClear: clearBands,
                    canClear: bands.hasBands,
                  }}
                  direction={{
                    value: direction,
                    onChange: (d) => {
                      setDirection(d)
                      // A saved LR layout doesn't fit TB - re-run the layout.
                      dropAllPositions()
                      setLayoutTick((t) => t + 1)
                    },
                  }}
                  levels={grouped ? undefined : levelsProps}
                />
              </>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <BarMenuTrigger>
                      <Plus /> Add
                    </BarMenuTrigger>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onSelect={() => setPalette(true)}>
                      <PanelLeft /> Devices…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canBuild || !selNode?.device_id}
                      onSelect={() => void addConnected(selectedDevices())}
                    >
                      <Cable /> Connected devices
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={addZoneCentered}>
                      <Square /> Zone
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ArrangeMenu
                  onReset={() => {
                    setPositions(undefined)
                    setLayoutTick((t) => t + 1)
                  }}
                />
              </>
            )}
            {!barRoom.copyLink && (
              <BarButton onClick={copyLink} data-bar-item="copy-link">
                <LinkIcon /> Copy link
              </BarButton>
            )}
            <ExportMenu
              name={exportName}
              modes={isDiagram}
              shownMode={diagramMode}
              disabled={!graph}
              // Every file is drawn in the Diagram's look, whatever the tab.
              legend={legendRows({
                viewStyle: "diagram",
                grouped,
                colorMode,
                types: presentTypes,
                roles: rolesInGraph,
                monitorPill: cardMonitor,
              })}
              document={(req) =>
                canvas.current?.document({
                  ...req,
                  meta: exportMeta(),
                  notes,
                  origin: window.location.origin,
                }) ?? null
              }
            />
            {barRoom.copyLink && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <BarIconButton label="More" data-bar-item="more">
                    <MoreHorizontal />
                  </BarIconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  {barRoom.history && (
                    <>
                      <HistoryMenuItems {...steps} />
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {barRoom.objects && (
                    <>
                      <DropdownMenuCheckboxItem
                        checked={showObjects}
                        onCheckedChange={toggleObjects}
                      >
                        Objects
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => void copyLink()}>
                    <LinkIcon /> Copy link
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {paletteShown && (
          <DevicePalette
            placed={placedIds}
            editable={canBuild}
            panelsHidden={filters.collapse}
            onAdd={addFromList}
            onFocus={(id) => {
              canvas.current?.focusNode(devNode(id))
              canvas.current?.selectNode(devNode(id))
            }}
            onNewView={canAddViews ? () => setNewViewOpen(true) : undefined}
            onClose={() => setPalette(false)}
          />
        )}
        <div className="relative min-h-0 flex-1">
          {logical && <LogicalTopologyView />}
          {!logical && (q.isLoading || (!viewSettled && !graph)) && (
            <Loading className="absolute inset-0" />
          )}
          {!logical && q.isError && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <QueryError error={q.error} />
            </div>
          )}
          {!logical && graph && (
            <Suspense fallback={<Loading className="absolute inset-0" />}>
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
                diagramMode={diagramMode}
                diagramLine={diagramLine}
                chassis={chassisOpts}
                chassisActions={chassisActions}
                linkOverrides={doc.doc.links}
                diagramLabels={isDiagram ? diagramLabels : undefined}
                monitor={checks}
                bundleLags={lagMode === "on"}
                positions={positions}
                layoutTick={layoutTick}
                fitKey={
                  isDiagram && shownFace === "photo"
                    ? `${fitKey}|photo`
                    : fitKey
                }
                onDropDevices={canBuild ? dropDevices : undefined}
                pending={canBuild ? pendingCards : undefined}
                spreadFrom={spreadFrom}
                onSpread={onSpread}
                emptyState={
                  canBuild ? (
                    <EmptyState title="No devices yet." className="bg-card">
                      {paletteShown ? (
                        "Drag devices in from the list."
                      ) : (
                        <BarButton
                          className="mt-2"
                          onClick={() => setPalette(true)}
                        >
                          <PanelLeft /> Add devices…
                        </BarButton>
                      )}
                    </EmptyState>
                  ) : undefined
                }
                brokenLayout={
                  viewStyle === "hierarchy" ? (
                    <BarButton
                      className="mt-2"
                      onClick={() => setTab("diagram")}
                    >
                      Switch to Diagram
                    </BarButton>
                  ) : undefined
                }
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
                onSelectEdge={(d, id, link) => {
                  clearSel()
                  setSelEdge(d)
                  setSelEdgeId(id)
                  setSelLink(link ?? null)
                }}
                onSelectBundle={(cables, id, link) => {
                  clearSel()
                  setSelBundle(cables)
                  setSelEdgeId(id)
                  setSelLink(link ?? null)
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
                onZonesChange={isDiagram ? bands.onRegionsChange : setZones}
                onBandEdit={isDiagram ? bands.edit : undefined}
                notes={notes}
                onNotesChange={isDiagram ? setNotes : undefined}
                editNoteId={freshNote}
                onNodeContext={(node, x, y) => {
                  if (node.type === "zone" || node.type === "band")
                    setMenu({ x, y, zoneId: node.id.slice(5) })
                  else if (node.type === "chassis")
                    setMenu({
                      x,
                      y,
                      stack: node.data as unknown as ChassisNodeData,
                    })
                  else if (node.type === "sitegroup")
                    setMenu({
                      x,
                      y,
                      group: node.data as unknown as TopoGroupData,
                    })
                  else if (
                    node.type === "device" ||
                    node.type === "flat" ||
                    node.type === "hier" ||
                    node.type === "card"
                  )
                    setMenu({
                      x,
                      y,
                      node: node.data as TopoNode["data"],
                      nodeId: node.id,
                    })
                }}
                onPaneContext={(x, y, fx, fy) => setMenu({ x, y, fx, fy })}
                onEdgeContext={(line, x, y) => setMenu({ x, y, line })}
                onPartialChange={setPartialMap}
                keepClear={legendBox}
                onCanvasClick={clearSel}
                onDragEnd={() => {
                  const p = canvas.current?.positions()
                  if (!p) return
                  // Keep the arrangement in-session (so an incidental rebuild -
                  // colour/search - doesn't snap cards back) and, on the default
                  // view, persist it across reloads. Saved views persist via Save.
                  // The bands too, when the build re-fitted them round the cards.
                  if (isDiagram) bands.keepDrawn()
                  setPositions(p)
                }}
              />
            </Suspense>
          )}

          {/* The top-left corner is the one the canvas leaves free: the
              MiniMap is bottom-right, the legend and zoom controls
              bottom-left, and a detail panel opens top-right. Its chips
              stack: the large-map hint, Partial map, the hidden count. */}
          <div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-col items-start gap-2 [&>*]:pointer-events-auto">
            {graph &&
              viewStyle === "hierarchy" &&
              count > 60 &&
              !hintDismissed && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs">
                  <span className="whitespace-nowrap text-muted-foreground">
                    Large map
                  </span>
                  <InfoTip>
                    Hierarchy suits smaller maps; the Diagram scales better.
                  </InfoTip>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setTab("diagram")}
                  >
                    Switch to Diagram
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={dismissHint}
                        aria-label="Close"
                      >
                        <X />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" variant="default">
                      Close
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
            {!logical && graph && partialMap && <PartialMapChip />}
            {!showObjects && (
              <HiddenChip
                count={hiddenHere}
                position="top-left"
                // Stacked under the hint rather than on top of it.
                className="static"
                onShowAll={() => setHiddenNodes(NO_TOPO_HIDDEN)}
              />
            )}
          </div>
          {!logical && graph && (
            // left-16 clears React Flow's zoom controls in the corner; a
            // fit keeps the map clear of it (keepClear).
            <div ref={legendBox} className="absolute bottom-4 left-16 z-10">
              <CanvasLegend
                viewStyle={viewStyle}
                grouped={grouped}
                colorMode={colorMode}
                types={presentTypes}
                roles={rolesInGraph}
                monitorPill={cardMonitor}
              />
            </div>
          )}
          {selNode && (
            <NodePanel
              data={selNode}
              monitor={
                monQuery.data && selNode.device_id
                  ? (checks[selNode.device_id]?.status ?? null)
                  : undefined
              }
              onClose={() => setSelNode(null)}
              onFocus={(id) => {
                focusDevice(id)
                setSelNode(null)
              }}
            />
          )}
          {selEdge && (
            <EdgePanel
              data={selEdge}
              onClose={() => setSelEdge(null)}
              line={lineRow}
            />
          )}
          {selBundle && (
            <BundlePanel
              cables={selBundle}
              onClose={() => setSelBundle(null)}
              line={lineRow}
            />
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
            onReorderBands={isDiagram ? bands.reorder : undefined}
          />
        )}
      </div>

      <PointerMenu
        menu={menu}
        onClose={() => setMenu(null)}
        label={
          menu?.node
            ? "Device"
            : menu?.stack
              ? "Virtual chassis"
              : menu?.group
                ? "Group"
                : menu?.zoneId
                  ? "Area"
                  : menu?.line
                    ? "Line"
                    : "Map"
        }
        keys={(m) =>
          m.node
            ? deviceMenuKeys(deviceMenu(m.node, m.nodeId))
            : m.group
              ? groupMenuKeys(groupMenu(m.group))
              : m.line
                ? edgeMenuKeys(lineMenu(m.line))
                : {}
        }
      >
        {(m) => {
          if (m.node)
            return <DeviceMenuItems {...deviceMenu(m.node, m.nodeId)} />
          if (m.group) return <GroupMenuItems {...groupMenu(m.group)} />
          if (m.line) return <EdgeMenuItems {...lineMenu(m.line)} />
          if (m.stack)
            return (
              <ChassisMenuItems
                {...chassisMenu(m.stack.vc.id, m.stack.orient, m.stack.members)}
              />
            )
          if (m.zoneId) {
            const id = m.zoneId
            const region = zones?.find((z) => z.id === id)
            return (
              <RegionMenuItems
                kind={region?.kind === "band" ? "band" : "zone"}
                color={region?.color || null}
                {...(region?.kind === "band" && region.orient !== "v"
                  ? {
                      exits: {
                        value: region.exits,
                        onChange: (exits) => setExits(id, exits),
                      },
                    }
                  : {})}
                onRename={() => canvas.current?.renameRegion(id)}
                onRecolor={(c) => recolorZone(id, c)}
                onDelete={() => removeZone(id)}
              />
            )
          }
          const { fx, fy } = m
          return (
            <PaneMenuItems
              tab={isDiagram ? "diagram" : "hierarchy"}
              builder={builder}
              notesFull={notesFull}
              onAddDevices={() => {
                // The list opens, and what it adds next lands here.
                if (canBuild && fx !== undefined && fy !== undefined)
                  setAddAt({ x: fx, y: fy })
                setPalette(true)
              }}
              onAddBand={bands.addRow}
              onAddZone={() => addZone(fx ?? 0, fy ?? 0)}
              onAddText={() => addNote(null, { x: fx ?? 0, y: fy ?? 0 })}
              onBackToFiltered={exitBuilder}
            />
          )
        }}
      </PointerMenu>

      <NewViewDialog
        open={newViewOpen}
        onOpenChange={setNewViewOpen}
        mapCount={
          grouped || !graph
            ? null
            : graph.nodes.filter((n) => n.data.device_id).length
        }
        stateFor={newViewState}
        taken={views.data?.results.map((v) => v.name)}
        onCreated={(v) => {
          // Opened from what was just written, not a second fetch.
          qc.setQueryData(["topology-view", v.id], v)
          void qc.invalidateQueries({ queryKey: ["topology-views"] })
          setPalette(true)
          patch({ view: v.id, ...noOverrides() })
          toast.success(`Created “${v.name}”`)
        }}
      />
      <MaterializeCableDialog ghost={ghost} onClose={() => setGhost(null)} />
      <CardLinesDialog
        target={cardLinesFor}
        viewFields={savedDiagram?.fields}
        onClose={() => setCardLinesFor(null)}
      />
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

      <ConfirmDialog
        open={!!bandAsk}
        onOpenChange={(open) => {
          if (!open) setBandAsk(null)
        }}
        title={bandAsk?.by ? "Replace bands?" : "Clear bands?"}
        description={
          bandAsk?.by
            ? "Bands drawn by hand are replaced by the new ones. Undo puts them back."
            : "Every band goes, including those drawn by hand. The cards stay. Undo puts them back."
        }
        confirmLabel={bandAsk?.by ? "Replace" : "Clear"}
        onConfirm={() => {
          const ask = bandAsk
          setBandAsk(null)
          if (ask?.by) bands.arrange(ask.by)
          else if (ask) bands.clear()
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!deleteView.isPending) setConfirmDelete(open)
        }}
        title={
          appliedView?.name ? `Delete “${appliedView.name}”?` : "Delete view?"
        }
        description={
          <>
            Its layout, bands, zones and text go with it. This can't be undone.
            {isDefault && (
              <span className="mt-2 block">It's the default view.</span>
            )}
          </>
        }
        pending={deleteView.isPending}
        onConfirm={() =>
          deleteView.mutate({ id: viewId, name: appliedView?.name })
        }
      />

      <LeaveGuardDialog blocker={leaveGuard} />
    </div>
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
  /** Prefilled name (the stale-view dialog's Save as… offers "<view>
   * (copy)"). */
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
          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
