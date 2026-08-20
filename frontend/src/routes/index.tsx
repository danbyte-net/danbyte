import { Suspense, useEffect, useRef, useState, type ReactNode } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  Check,
  GripVertical,
  LayoutGrid,
  Pencil,
  Plus,
  RotateCcw,
  X,
} from "lucide-react"
import {
  Responsive,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import { api, type DashboardData } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { QueryError } from "@/components/query-error"
import {
  CATALOG,
  CATALOG_BY_ID,
  DEFAULT_LAYOUT,
  metaFor,
  type WidgetFit,
  type WidgetId,
} from "@/components/dashboard/catalog"
import {
  ROW_HEIGHT,
  fromRglLayout,
  normalizeLayout,
  placeIds,
  toRglLayout,
  type DashItem,
} from "@/lib/dashboard-layout"

export const Route = createFileRoute("/")({ component: Dashboard })

const LS_KEY = "danbyte-dashboard-widgets"

const builtinLayout = () => placeIds(DEFAULT_LAYOUT, metaFor)

/** The locally cached layout - accepts the old v1 id array AND v2, so an
 * existing user's arrangement upgrades in place instead of resetting. */
function loadLocalLayout(): DashItem[] | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    return raw ? normalizeLayout(JSON.parse(raw), metaFor) : null
  } catch {
    return null
  }
}

function Dashboard() {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<DashboardData>("/api/dashboard/"),
  })

  // Honour the user's landing-page preference once per browser session: the
  // first time "/" loads, bounce to their chosen page. Subsequent visits
  // (e.g. clicking the Dashboard nav) stay here so the dashboard is reachable.
  const nav = useNavigate()
  const { values: prefs } = useUserPrefs()
  useEffect(() => {
    const dest = prefs.landing_page
    if (typeof dest !== "string" || dest === "/" || dest === "") return
    if (sessionStorage.getItem("danbyte-landed")) return
    sessionStorage.setItem("danbyte-landed", "1")
    nav({ to: dest as never })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.landing_page])

  const { canManage } = useMe()
  const [items, setItems] = useState<DashItem[]>([])
  const [hydrated, setHydrated] = useState(false)

  // The server-side per-user layout - the primary source, so an arrangement
  // follows you across browsers. localStorage is the boot cache and the
  // migration path for pre-#41 layouts.
  const pref = useQuery({
    queryKey: ["dashboard-pref"],
    queryFn: () =>
      api<{ source: string; data: unknown }>("/api/prefs/dashboard/"),
  })

  const putServer = (layout: DashItem[]) =>
    api("/api/prefs/dashboard/", {
      method: "PUT",
      body: JSON.stringify({ v: 2, items: layout }),
    }).catch(() => {
      /* offline / no tenant - localStorage still has it */
    })

  // Resolve the initial layout once both the server pref and the dashboard
  // payload (which carries the tenant default) have answered. Precedence:
  // server pref → localStorage (adopted upward with one PUT) → tenant
  // default → built-in.
  const resolved = useRef(false)
  useEffect(() => {
    if (resolved.current || pref.isLoading || !q.data) return
    resolved.current = true
    const server = normalizeLayout(pref.data?.data, metaFor)
    if (server) {
      setItems(server)
    } else {
      const local = loadLocalLayout()
      if (local) {
        setItems(local)
        void putServer(local) // one-time adoption of the pre-server layout
      } else {
        const tenantDefault = normalizeLayout(q.data.default_widgets, metaFor)
        setItems(tenantDefault ?? builtinLayout())
      }
    }
    setHydrated(true)
  }, [pref.isLoading, pref.data, q.data])

  // Debounced persistence: localStorage immediately (cheap, survives
  // refresh), the server after the gesture settles.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persist = (next: DashItem[]) => {
    setItems(next)
    try {
      window.localStorage.setItem(
        LS_KEY,
        JSON.stringify({ v: 2, items: next })
      )
    } catch {
      /* storage blocked */
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void putServer(next), 400)
  }

  const add = (id: WidgetId) => {
    if (items.some((x) => x.id === id)) return
    const meta = metaFor(id)
    const bottom = items.reduce((m, x) => Math.max(m, x.y + x.h), 0)
    persist([
      ...items,
      { id, x: 0, y: bottom, w: meta.span.w, h: meta.span.h },
    ])
  }
  const remove = (id: WidgetId) => persist(items.filter((x) => x.id !== id))
  const reset = async () => {
    // Reset = drop MY layout: server row and local cache go, and the
    // effective layout falls back to the tenant default, then the built-in.
    try {
      await api("/api/prefs/dashboard/", { method: "DELETE" })
    } catch {
      /* offline - local reset still applies */
    }
    try {
      window.localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
    const tenantDefault = normalizeLayout(q.data?.default_widgets, metaFor)
    setItems(tenantDefault ?? builtinLayout())
  }

  // Edit mode gates dragging/resizing/removal, so the normal dashboard stays
  // clean and read-only until you choose to rearrange it.
  const [editing, setEditing] = useState(false)

  // While a drag OR resize gesture is in flight every widget body is
  // unmounted into a placeholder - the #42 guard. Live-streaming the width
  // changes into a mounted recharts chart ends in React #185.
  const [interacting, setInteracting] = useState(false)

  const saveAsDefault = async () => {
    try {
      await api("/api/tenant-settings/", {
        method: "PUT",
        body: JSON.stringify({
          default_dashboard_widgets: { v: 2, items },
        }),
      })
      toast.success("Saved as the starting layout for new users")
    } catch (e) {
      apiErrorToast(e)
    }
  }

  const d = q.data
  const available = CATALOG.filter((w) => !items.some((x) => x.id === w.id))

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-4 p-4 md:p-6">
        <header className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your IPAM &amp; DCIM at a glance.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {editing && canManage && (
              <Button variant="ghost" size="sm" onClick={saveAsDefault}>
                <LayoutGrid className="h-3.5 w-3.5" /> Set as new-user default
              </Button>
            )}
            {editing && (
              <Button variant="ghost" size="sm" onClick={reset}>
                <RotateCcw className="h-3.5 w-3.5" /> Reset
              </Button>
            )}
            <Button
              variant={editing ? "default" : "outline"}
              size="sm"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? (
                <>
                  <Check className="h-3.5 w-3.5" /> Done
                </>
              ) : (
                <>
                  <Pencil className="h-3.5 w-3.5" /> Edit layout
                </>
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={editing ? "" : "hidden"}
                >
                  <Plus className="h-3.5 w-3.5" /> Add widget
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="text-[10px] tracking-wider uppercase">
                  Widgets
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {available.length === 0 && (
                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                    All widgets added.
                  </div>
                )}
                {available.map((w) => (
                  <DropdownMenuItem
                    key={w.id}
                    onClick={() => add(w.id)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="text-[13px] font-medium">{w.title}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {w.description}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {q.isError && <QueryError error={q.error} />}

        {d && <StatBand d={d} />}

        {/* The widget grid (react-grid-layout, #41): drag the handle to
            move, drag the corner to resize - both snap to grid cells and only
            in edit mode. Vertical compaction keeps it gap-free. */}
        {d && hydrated && <DashboardGrid
          items={items}
          editing={editing}
          interacting={interacting}
          setInteracting={setInteracting}
          persist={persist}
          remove={remove}
          d={d}
        />}
        {d && hydrated && items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
            <LayoutGrid className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No widgets. Use <span className="font-medium">Add widget</span>{" "}
              to build your dashboard.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/** The grid itself - separated so useContainerWidth only runs when data is
 * ready (hooks stay above every early return, per the hook-order guard). */
function DashboardGrid({
  items,
  editing,
  interacting,
  setInteracting,
  persist,
  remove,
  d,
}: {
  items: DashItem[]
  editing: boolean
  interacting: boolean
  setInteracting: (v: boolean) => void
  persist: (next: DashItem[]) => void
  remove: (id: WidgetId) => void
  d: DashboardData
}) {
  const { width, containerRef, mounted } = useContainerWidth()
  // The stop callbacks receive the final layout - one commit point, so a
  // span can never change while widget bodies are mounted (#42 guard).
  const onStop = (
    layout: readonly { i: string; x: number; y: number; w: number; h: number }[]
  ) => {
    setInteracting(false)
    persist(fromRglLayout(layout))
  }
  return (
    <div ref={containerRef}>
      {mounted && width > 0 && (
        <Responsive
          width={width}
          breakpoints={{ xl: 1100, lg: 800, sm: 520, xs: 0 }}
          cols={{ xl: 6, lg: 4, sm: 2, xs: 1 }}
          rowHeight={ROW_HEIGHT}
          margin={[16, 16]}
          containerPadding={[0, 0]}
          compactor={verticalCompactor}
          layouts={{ xl: toRglLayout(items, metaFor) }}
          dragConfig={{ enabled: editing, handle: ".dash-drag-handle" }}
          resizeConfig={{ enabled: editing }}
          onDragStart={() => setInteracting(true)}
          onResizeStart={() => setInteracting(true)}
          onDragStop={onStop}
          onResizeStop={onStop}
        >
          {items.map((it) => {
            const w = CATALOG_BY_ID[it.id as WidgetId]
            if (!w) return null
            return (
              <div key={it.id}>
                <WidgetTile
                  title={w.title}
                  description={w.description}
                  fit={w.fit ?? "scroll"}
                  editing={editing}
                  interacting={interacting}
                  onRemove={() => remove(it.id as WidgetId)}
                >
                  {w.render(d)}
                </WidgetTile>
              </div>
            )
          })}
        </Responsive>
      )}
    </div>
  )
}

/** One widget card. The grid supplies the height; `fit` says how the body
 * copes - lists scroll, fixed-size charts centre, the map stretches. */
const FIT_CLASS: Record<WidgetFit, string> = {
  scroll: "min-h-0 flex-1 overflow-auto",
  center: "min-h-0 flex-1 flex flex-col justify-center overflow-hidden",
  stretch: "min-h-0 flex-1 overflow-hidden",
}

function WidgetTile({
  title,
  description,
  fit,
  editing,
  interacting,
  onRemove,
  children,
}: {
  title: string
  description: string
  fit: WidgetFit
  editing: boolean
  interacting: boolean
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-card p-3.5 ${
        editing ? "border-dashed border-primary/40" : "border-border"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {description}
          </div>
        </div>
        {editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <span
              className="dash-drag-handle cursor-grab touch-none rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
              title="Drag to move"
              aria-label="Drag to move"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Remove widget"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      {/* While any drag/resize is in flight the body is a static box: no
          ResizeObserver runs, so recharts can't loop into React #185. */}
      {interacting ? (
        <div className="min-h-0 flex-1 rounded-md bg-muted/30" />
      ) : (
        <div className={FIT_CLASS[fit]}>
          <Suspense
            fallback={
              <div className="h-32 animate-pulse rounded-md bg-muted/40" />
            }
          >
            {children}
          </Suspense>
        </div>
      )}
    </div>
  )
}

/** Full-width count + health strip across the top. */
function StatBand({ d }: { d: DashboardData }) {
  const alerts = (d.alerts_by_severity ?? []).reduce((n, a) => n + a.count, 0)
  const cells: {
    label: string
    value: number | string
    to?: string
    tone?: "ok" | "warn" | "bad"
  }[] = [
    { label: "Sites", value: d.counts.sites ?? 0, to: "/sites" },
    { label: "Prefixes", value: d.counts.prefixes ?? 0, to: "/prefixes" },
    { label: "IP addresses", value: d.counts.ips ?? 0 },
    { label: "VLANs", value: d.counts.vlans ?? 0, to: "/vlans" },
    { label: "Devices", value: d.counts.devices ?? 0, to: "/devices" },
    { label: "Cables", value: d.counts.cables ?? 0, to: "/cables" },
    {
      label: "Reachable",
      value: d.reachable_pct != null ? `${d.reachable_pct}%` : "-",
      tone:
        d.reachable_pct == null
          ? undefined
          : d.reachable_pct >= 95
            ? "ok"
            : d.reachable_pct >= 80
              ? "warn"
              : "bad",
    },
    {
      label: "Firing alerts",
      value: alerts,
      to: "/alerts",
      tone: alerts > 0 ? "bad" : undefined,
    },
  ]
  const tone = {
    ok: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    bad: "text-red-600 dark:text-red-400",
  }
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-4 xl:grid-cols-8">
      {cells.map((c) => {
        const body = (
          <>
            <div className="text-[11px] text-muted-foreground">{c.label}</div>
            <div
              className={`num mt-1 text-2xl font-semibold tracking-tight tabular-nums ${c.tone ? tone[c.tone] : ""}`}
            >
              {typeof c.value === "number" ? c.value.toLocaleString() : c.value}
            </div>
          </>
        )
        return c.to ? (
          <Link
            key={c.label}
            to={c.to}
            className="p-3.5 transition-colors hover:bg-muted/40"
          >
            {body}
          </Link>
        ) : (
          <div key={c.label} className="p-3.5">
            {body}
          </div>
        )
      })}
    </div>
  )
}
