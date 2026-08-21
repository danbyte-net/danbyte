import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Camera,
  Crosshair,
  Filter,
  LayoutGrid,
  Link2 as LinkIcon,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  api,
  type GhostEdgeData,
  type Paginated,
  type Status,
  type TagOption,
  type TopoEdge,
  type TopoNode,
  type TopologyGraph,
  type TopologyViewSaved,
} from "@/lib/api"
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
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Combobox } from "@/components/ui/combobox"
import { FormCheckbox } from "@/components/forms"
import { LevelOrganiser } from "@/components/topology/level-organiser"
import { CanvasLegend } from "@/components/topology/legend"
import { LogicalTopologyView } from "@/components/topology/logical-view"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { MaterializeCableDialog } from "@/components/topology/materialize-cable-dialog"
import {
  typeColor,
  type BundleMember,
  type CanvasHandle,
  type EdgeColorMode,
  type NodeStyle,
} from "@/components/topology/topology-canvas"
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
  mergePositions,
  migratePositions,
  viewPositions,
  type PosByStyle,
  type PosMap,
} from "@/components/topology/view-positions"

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
  cables?: "routed" | "straight"
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
    const cables = oneOf(s.cables, ["routed", "straight"] as const)
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
  "dir", "color", "cables", "levels", "device", "depth", "devices", "q",
  "vlangroup", "vms",
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

// Display settings (Levels order/bonds/distances, direction, colour mode,
// edge routing) for the DEFAULT topology - like the dragged positions above,
// they must survive a reload. Saved views persist theirs via Save.
const DISPLAY_KEY = "danbyte-topology-display"
interface StoredDisplay {
  colorMode?: EdgeColorMode
  direction?: "LR" | "TB"
  roleOrder?: string[]
  roleBonds?: string[]
  roleDistance?: Record<string, number>
  edgeRouting?: "routed" | "straight"
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
const ROUTINGS = ["routed", "straight"] as const
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
    edgeRouting: "routed" | "straight"
    viewStyle: ViewStyle
    groupBy: GroupBy
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

function TopologyPage() {
  const urlSearch = Route.useSearch()
  const nav = useNavigate()
  const patch = useUrlPatch()
  const { canDo } = useMe()
  const qc = useQueryClient()
  const canvas = useRef<CanvasHandle>(null)

  // Saved views are fetched first: an applied one supplies the fallback for
  // every control the URL doesn't override.
  const views = useQuery({
    queryKey: ["topology-views"],
    queryFn: () => api<Paginated<TopologyViewSaved>>("/api/topology-views/"),
  })
  const viewId = urlSearch.view ?? "none"
  const appliedView = views.data?.results.find((v) => v.id === viewId)
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
    node?: TopoNode["data"]
    group?: TopoGroupData
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
  // One arrangement per view style - see PosByStyle. The canvas only ever
  // sees the style it is currently drawing.
  const [posByStyle, setPosByStyle] = useState<PosByStyle>(() =>
    readStoredPositions(styleOfTab(dflt.tab) as NodeStyle)
  )
  const positions = logical ? undefined : posByStyle[viewStyle as NodeStyle]
  /** Replace the arrangement of the style on screen (undefined = re-layout
   * it); every other style keeps the one the user tuned. */
  const setPositions = (p: PosMap | undefined) => {
    if (logical) return
    const next = { ...posByStyle }
    if (p) next[viewStyle as NodeStyle] = p
    else delete next[viewStyle as NodeStyle]
    setPosByStyle(next)
    // Only the default map persists to the browser; a saved view's
    // arrangements are written by Save.
    if (viewId === "none") writeStoredPositions(next)
  }
  /** Every style's arrangement is stale - the map is about to hold a
   * different set of devices. */
  const dropAllPositions = () => {
    setPosByStyle({})
    if (viewId === "none") clearStoredPositions()
  }
  const [layoutTick, setLayoutTick] = useState(0)
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
    setLayoutTick((t) => t + 1)
  }

  const leaveDrill = () => {
    patch({ [groupBy === "location" ? "location" : "site"]: "all" })
    clearSel()
    dropAllPositions()
    setLayoutTick((t) => t + 1)
  }

  /** Builder: merge ids into the custom set (starting it if needed). */
  const addToCustom = (ids: string[]) =>
    setCustom([...new Set([...(custom ?? []), ...ids])])

  /** Leaving the builder. A saved view whose whole point IS its device set
   * can't survive losing it, so that view is left behind too. */
  const exitBuilder = () => {
    patch({ devices: undefined, ...(vf.devices ? { view: undefined } : {}) })
    clearSel()
    dropAllPositions()
    setLayoutTick((t) => t + 1)
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
  const graphQs = useMemo(() => {
    const p = new URLSearchParams()
    if (custom !== null) {
      // Builder mode: exactly this set, nothing else.
      p.set("devices", custom.join(","))
      p.set("collapse_panels", filters.collapse ? "1" : "0")
      return p.toString()
    }
    if (focus && !grouped) {
      p.set("device", focus.id)
      p.set("depth", String(focus.depth))
    } else {
      if (filters.site !== "all") p.set("site", filters.site)
      if (filters.role !== "all") p.set("role", filters.role)
      if (filters.status !== "all") p.set("status", filters.status)
      if (filters.tag !== "all") p.set("tag", filters.tag)
      if (grouped) p.set("group_by", groupBy)
      // Drilled into a group: the device view scoped to that one group. Its
      // id is already on the matching filter param, so nothing extra here.
      if (drill && drill.kind === "location") p.set("location", drill.id)
    }
    p.set("collapse_panels", filters.collapse ? "1" : "0")
    return p.toString()
  }, [filters, focus, grouped, groupBy, drill, custom])

  const q = useQuery({
    queryKey: ["topology", graphQs],
    queryFn: () => api<TopologyGraph>(`/api/topology/?${graphQs}`),
    enabled: !logical,
  })
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

  const graph = useMemo<TopologyGraph | undefined>(() => {
    if (!q.data) return undefined
    const present = new Set(q.data.nodes.map((n) => n.id))
    const ghostEdges = (ghosts.data?.edges ?? []).filter(
      (e) => present.has(e.source) && present.has(e.target)
    )
    return { ...q.data, edges: [...q.data.edges, ...ghostEdges] }
  }, [q.data, ghosts.data])

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

  // ── Saved views ──
  /** Applying a view is one navigation to `?view=<id>`, clearing every other
   * param: the view's own settings then supply the fallbacks, so the link
   * stays short and keeps showing the view as it is saved today. Anything the
   * user changes afterwards lands back on the URL as an override, which is
   * what `edited` below reports. */
  const applyView = (v: TopologyViewSaved) => {
    patch({
      view: v.id,
      ...Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, undefined])),
    })
    // Every style gets back exactly the arrangement it was saved with. A view
    // used to DISCARD them when it had Levels set, on the theory that a tiered
    // view should regenerate from its tiers - but discarding them here also
    // emptied what a later Save wrote back, so saving from one view deleted
    // the other views' arrangements. Tiers still drive anything unpinned, and
    // Re-layout regenerates on demand.
    setPosByStyle(viewPositions(v, sanitizeViewStyle))
    setLayoutTick((t) => t + 1)
  }

  /** Back to the personal default map: no view, no overrides. */
  const clearView = () => {
    patch({
      view: undefined,
      ...Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, undefined])),
    })
    setPosByStyle(readStoredPositions(viewStyle as NodeStyle))
    setLayoutTick((t) => t + 1)
  }

  /** The applied view has been changed since it was applied - the URL carries
   * at least one override on top of `?view=`. */
  const edited =
    viewId !== "none" &&
    OVERRIDE_KEYS.some(
      (k) => (urlSearch as Record<string, unknown>)[k] !== undefined
    )

  const currentState = () => {
    // Save the arrangement of every style the user has tuned, not just the one
    // on screen - a view is the whole map, and switching to Hierarchy must not
    // hand you the Flat spacing.
    const live = logical ? undefined : canvas.current?.positions()
    const byStyle = mergePositions(
      posByStyle,
      logical ? null : (viewStyle as NodeStyle),
      live
    )
    return {
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
        ...(custom !== null ? { devices: custom } : {}),
      },
      positions_by_style: byStyle,
      // Kept in step for anything still reading the single-map field.
      positions: byStyle[viewStyle as NodeStyle] ?? {},
    }
  }

  const saveView = useMutation({
    mutationFn: (args: { id?: string; name?: string }) => {
      if (args.id)
        return api<TopologyViewSaved>(`/api/topology-views/${args.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ state: currentState() }),
        })
      return api<TopologyViewSaved>("/api/topology-views/", {
        method: "POST",
        body: JSON.stringify({ name: args.name, state: currentState() }),
      })
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["topology-views"] })
      // The saved view now describes the map, so the overrides that produced
      // it are no longer overrides - the URL collapses back to just the id.
      patch({
        view: v.id,
        ...Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, undefined])),
      })
      setSaveAsOpen(false)
      toast.success(`Saved “${v.name}”`)
    },
    onError: (err) => apiErrorToast(err),
  })
  const deleteView = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/topology-views/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["topology-views"] })
      clearView()
      toast.success("View deleted")
    },
    onError: (err) => apiErrorToast(err),
  })

  /** This map, as a link someone else can open. */
  const copyLink = async () => {
    const ok = await copyText(window.location.href)
    if (ok) toast.success("Link copied")
    else toast.error("Couldn't copy - clipboard blocked by the browser")
  }

  const exportPng = async () => {
    const url = await canvas.current?.exportPng()
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
  const canWriteViews = canDo("topologyview", "add")
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
            // discard it, and switching back restores it. A style you have
            // never arranged lays itself out.
            setViewStyle(v)
            if (v !== "logical" && !posByStyle[v as NodeStyle])
              setLayoutTick((t) => t + 1)
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
                    setPositions(undefined)
                    setLayoutTick((t) => t + 1)
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
                  <SegmentedTabs<"routed" | "straight">
                    value={edgeRouting}
                    onValueChange={setEdgeRouting}
                    items={[
                      { value: "routed", label: "Routed" },
                      { value: "straight", label: "Straight" },
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
        {canWriteViews && (
          <>
            {viewId !== "none" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs whitespace-nowrap"
                onClick={() => saveView.mutate({ id: viewId })}
                disabled={saveView.isPending}
              >
                <Save className="h-3 w-3" /> Save
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs whitespace-nowrap"
              onClick={() => setSaveAsOpen(true)}
            >
              <Save className="h-3 w-3" /> Save as…
            </Button>
            {viewId !== "none" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive"
                onClick={() => deleteView.mutate(viewId)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAddOpen(true)}
            title="Add a device to the map - starts a custom map you grow by right-clicking nodes"
          >
            <Plus className="h-3 w-3" /> Add device
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setPositions(undefined)
              setLayoutTick((t) => t + 1)
            }}
            title="Discard this view's dragged positions, re-run the auto layout"
          >
            <LayoutGrid className="h-3 w-3" /> Re-layout
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={copyLink}
            title="Copy a link to this map - views, filters and display settings included"
          >
            <LinkIcon className="h-3 w-3" /> Link
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={exportPng}
          >
            <Camera className="h-3 w-3" /> PNG
          </Button>
        </div>
      </div>

      )}

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
              positions={positions}
              layoutTick={layoutTick}
              fitKey={graphQs}
              matchedIds={matchedIds}
              selectedEdgeId={selEdgeId}
              onGhostEdge={setGhost}
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
              onNodeContext={(node, x, y) => {
                if (node.type === "sitegroup")
                  setMenu({ x, y, group: node.data as unknown as TopoGroupData })
                else if (node.type === "device" || node.type === "flat")
                  setMenu({ x, y, node: node.data as TopoNode["data"] })
              }}
              onPaneContext={(x, y) => setMenu({ x, y })}
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

        {graph && viewStyle === "hierarchy" && count > 60 && !hintDismissed && (
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm">
            <span className="text-muted-foreground">
              Hierarchy suits smaller maps - Wiring scales better here.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                setViewStyle("stencil")
                if (!posByStyle.stencil) setLayoutTick((t) => t + 1)
              }}
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
              onClick={() => {
                setViewStyle("flat")
                if (!posByStyle.flat) setLayoutTick((t) => t + 1)
              }}
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
            {!menu.node && !menu.group && (
              <>
                <MenuItem
                  onClick={() => {
                    setMenu(null)
                    setAddOpen(true)
                  }}
                >
                  Add device…
                </MenuItem>
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
        onPick={(id) => addToCustom([id])}
      />
      <MaterializeCableDialog ghost={ghost} onClose={() => setGhost(null)} />
      <SaveAsDialog
        open={saveAsOpen}
        onOpenChange={setSaveAsOpen}
        onSave={(name) => saveView.mutate({ name })}
        busy={saveView.isPending}
      />
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
function AddDeviceDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (deviceId: string) => void
}) {
  const devices = useQuery({
    queryKey: ["devices-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/devices/?picker=1"),
    staleTime: 60_000,
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add device to the map</DialogTitle>
        </DialogHeader>
        <Combobox
          value={null}
          onChange={(v) => {
            if (!v) return
            onPick(v)
            onOpenChange(false)
          }}
          options={(devices.data?.results ?? []).map((d) => ({
            value: d.id,
            label: d.name,
          }))}
          placeholder="Pick a device…"
          searchPlaceholder="Search devices…"
          emptyText={devices.isLoading ? "Loading…" : "No devices."}
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
function BundlePanel({
  cables,
  onClose,
}: {
  cables: BundleMember[]
  onClose: () => void
}) {
  return (
    <PanelShell
      title={`${cables.length} cable${cables.length === 1 ? "" : "s"}`}
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
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onSave: (name: string) => void
  busy: boolean
}) {
  const [name, setName] = useState("")
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
