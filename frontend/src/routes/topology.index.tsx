import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Camera,
  Crosshair,
  Filter,
  LayoutGrid,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { lazy, Suspense, useMemo, useRef, useState } from "react"
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
import { LevelOrganiser } from "@/components/topology/level-organiser"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { MaterializeCableDialog } from "@/components/topology/materialize-cable-dialog"
import {
  typeColor,
  type CanvasHandle,
  type EdgeColorMode,
} from "@/components/topology/topology-canvas"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

const TopologyCanvas = lazy(() =>
  import("@/components/topology/topology-canvas").then((m) => ({
    default: m.TopologyCanvas,
  }))
)

export const Route = createFileRoute("/topology/")({
  component: TopologyPage,
  validateSearch: (s: Record<string, unknown>): { device?: string } =>
    typeof s.device === "string" ? { device: s.device } : {},
})

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

const NO_FILTERS: Filters = {
  site: "all",
  role: "all",
  status: "all",
  tag: "all",
  collapse: true,
}

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
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-full text-xs">
        <SelectValue placeholder={anyLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{anyLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
// browser so a manual arrangement survives a reload.
const POS_KEY = "danbyte-topology-positions"
function readStoredPositions(): Record<string, [number, number]> | undefined {
  try {
    const raw = localStorage.getItem(POS_KEY)
    return raw
      ? (JSON.parse(raw) as Record<string, [number, number]>)
      : undefined
  } catch {
    return undefined
  }
}
function writeStoredPositions(p: Record<string, [number, number]>) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    /* quota / private mode — non-fatal */
  }
}
function clearStoredPositions() {
  try {
    localStorage.removeItem(POS_KEY)
  } catch {
    /* non-fatal */
  }
}

function TopologyPage() {
  const { device: deepLinkDevice } = Route.useSearch()
  const { canDo } = useMe()
  const qc = useQueryClient()
  const canvas = useRef<CanvasHandle>(null)

  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [colorMode, setColorMode] = useState<EdgeColorMode>("cable")
  const [direction, setDirection] = useState<"LR" | "TB">("LR")
  const [roleOrder, setRoleOrder] = useState<string[]>([])
  // Roles bonded to the level of the role above them — lets several roles share
  // one level (core switches beside routers, say).
  const [roleBonds, setRoleBonds] = useState<string[]>([])
  const [roleDistance, setRoleDistance] = useState<Record<string, number>>({})
  // Edge rendering: "routed" bends cables around cards; "straight" is the plain
  // orthogonal (smoothstep) line. A user choice, not tied to layout mode.
  const [edgeRouting, setEdgeRouting] = useState<"routed" | "straight">(
    "routed"
  )
  const [search, setSearch] = useState("")
  const [focus, setFocus] = useState<{ id: string; depth: number } | null>(
    deepLinkDevice ? { id: deepLinkDevice, depth: 1 } : null
  )
  const [viewId, setViewId] = useState<string>("none")
  const [positions, setPositions] = useState<
    Record<string, [number, number]> | undefined
  >(readStoredPositions)
  const [layoutTick, setLayoutTick] = useState(0)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [ghost, setGhost] = useState<GhostEdgeData | null>(null)
  const [selNode, setSelNode] = useState<TopoNode["data"] | null>(null)
  const [selEdge, setSelEdge] = useState<NonNullable<TopoEdge["data"]> | null>(
    null
  )

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setViewId("none")
    setPositions(undefined)
  }

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
  const views = useQuery({
    queryKey: ["topology-views"],
    queryFn: () => api<Paginated<TopologyViewSaved>>("/api/topology-views/"),
  })

  // ── Graph ──
  const graphQs = useMemo(() => {
    const p = new URLSearchParams()
    if (focus) {
      p.set("device", focus.id)
      p.set("depth", String(focus.depth))
    } else {
      if (filters.site !== "all") p.set("site", filters.site)
      if (filters.role !== "all") p.set("role", filters.role)
      if (filters.status !== "all") p.set("status", filters.status)
      if (filters.tag !== "all") p.set("tag", filters.tag)
    }
    p.set("collapse_panels", filters.collapse ? "1" : "0")
    return p.toString()
  }, [filters, focus])

  const q = useQuery({
    queryKey: ["topology", graphQs],
    queryFn: () => api<TopologyGraph>(`/api/topology/?${graphQs}`),
  })
  const ghosts = useQuery({
    queryKey: ["topology-ghosts", filters.site],
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
  const applyView = (v: TopologyViewSaved) => {
    setViewId(v.id)
    const f = (v.state.filters ?? {}) as Partial<
      Filters & {
        colorMode: EdgeColorMode
        direction: "LR" | "TB"
        roleOrder: string[]
        roleBonds: string[]
        roleDistance: Record<string, number>
        edgeRouting: "routed" | "straight"
      }
    >
    setFilters({
      site: f.site ?? "all",
      role: f.role ?? "all",
      status: f.status ?? "all",
      tag: f.tag ?? "all",
      collapse: f.collapse ?? true,
    })
    if (f.colorMode) setColorMode(f.colorMode)
    if (f.direction) setDirection(f.direction)
    if (f.edgeRouting) setEdgeRouting(f.edgeRouting)
    setRoleOrder(f.roleOrder ?? [])
    setRoleBonds(f.roleBonds ?? [])
    setRoleDistance(f.roleDistance ?? {})
    setFocus(null)
    // A tiered view (Levels) is defined by its role order + distances, so
    // regenerate it instead of re-pinning saved coordinates — otherwise the
    // pinned positions would suppress the tiers, distance dots, and routing.
    // Bumping the tick marks this as a deliberate relayout so the canvas uses
    // the fresh layout rather than keeping the previous view's node positions.
    if (f.roleOrder?.length) {
      setPositions(undefined)
      setLayoutTick((t) => t + 1)
    } else {
      setPositions(v.state.positions)
      setLayoutTick(0)
    }
  }

  const currentState = () => ({
    filters: {
      ...filters,
      colorMode,
      direction,
      roleOrder,
      roleBonds,
      roleDistance,
      edgeRouting,
    },
    positions: canvas.current?.positions() ?? {},
  })

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
      setViewId(v.id)
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
      setViewId("none")
      setPositions(undefined)
      toast.success("View deleted")
    },
    onError: (err) => apiErrorToast(err),
  })

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
            {count} device{count === 1 ? "" : "s"}
          </Badge>
        )}
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
          {focus ? (
            <Select
              value={String(focus.depth)}
              onValueChange={(v) =>
                setFocus((f) => f && { ...f, depth: Number(v) })
              }
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
          <LevelOrganiser
            roles={rolesInGraph}
            order={roleOrder}
            onChange={(o) => {
              setRoleOrder(o)
              setPositions(undefined)
              clearStoredPositions()
              setLayoutTick((t) => t + 1)
            }}
            bonds={roleBonds}
            onBonds={(b) => {
              setRoleBonds(b)
              // Bonding changes the tiers, so drop pinned coordinates and
              // relayout — same as reordering.
              setPositions(undefined)
              clearStoredPositions()
              setLayoutTick((t) => t + 1)
            }}
            distance={roleDistance}
            onDistance={(role, step) => {
              setRoleDistance((d) => ({ ...d, [role]: step }))
              setPositions(undefined)
              clearStoredPositions()
              setLayoutTick((t) => t + 1)
            }}
          />
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
              <PopoverField label="Layout">
                <SegmentedTabs<"LR" | "TB">
                  value={direction}
                  onValueChange={(d) => {
                    setDirection(d)
                    // A saved LR layout doesn't fit TB — re-run the layout.
                    setPositions(undefined)
                    clearStoredPositions()
                    setLayoutTick((t) => t + 1)
                  }}
                  items={[
                    { value: "LR", label: "Side-to-side" },
                    { value: "TB", label: "Tree" },
                  ]}
                />
              </PopoverField>
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
                    <SelectItem value="none">No color</SelectItem>
                  </SelectContent>
                </Select>
              </PopoverField>
              <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs">
                <input
                  type="checkbox"
                  className="ck ck-sm"
                  checked={!filters.collapse}
                  onChange={(e) => set({ collapse: !e.target.checked })}
                />
                Show patch panels
              </label>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {/* Second bar: saved views + actions. Scrolls within itself on
          narrow screens (scrollbar hidden) instead of panning the page. */}
      <div className="flex h-10 shrink-0 [scrollbar-width:none] items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden">
        <Select
          value={viewId}
          onValueChange={(v) => {
            if (v === "none") {
              setViewId("none")
              // Back to the default view — restore its saved drag arrangement.
              setPositions(readStoredPositions())
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
            onClick={() => {
              setPositions(undefined)
              clearStoredPositions()
              setLayoutTick((t) => t + 1)
            }}
            title="Discard dragged positions, re-run the auto layout"
          >
            <LayoutGrid className="h-3 w-3" /> Re-layout
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

      <div className="relative min-h-0 flex-1">
        {q.isLoading && (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        )}
        {q.isError && (
          <div className="p-6">
            <QueryError error={q.error} />
          </div>
        )}
        {graph && (
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
              positions={positions}
              layoutTick={layoutTick}
              matchedIds={matchedIds}
              onGhostEdge={setGhost}
              onSelectNode={(d) => {
                setSelNode(d)
                setSelEdge(null)
              }}
              onSelectEdge={(d) => {
                setSelEdge(d)
                setSelNode(null)
              }}
              onCanvasClick={() => {
                setSelNode(null)
                setSelEdge(null)
              }}
              onDragEnd={() => {
                const p = canvas.current?.positions()
                if (!p) return
                // Keep the arrangement in-session (so an incidental rebuild —
                // colour/search — doesn't snap cards back) and, on the default
                // view, persist it across reloads. Saved views persist via Save.
                setPositions(p)
                if (viewId === "none") writeStoredPositions(p)
              }}
            />
          </Suspense>
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
      </div>

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
    <div className="absolute top-3 right-3 z-10 w-72 rounded-lg border border-border bg-card shadow-sm">
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
        {!!d.via?.length && <Row label="Via">{d.via.join(", ")}</Row>}
      </div>
      {!!d.pairs?.length && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Connections
          </div>
          {d.pairs.map((p, i) => (
            <div key={i} className="truncate py-0.5 font-mono text-[11px]">
              {p.a} ↔ {p.b}
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
      <DialogContent className="sm:max-w-sm">
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
