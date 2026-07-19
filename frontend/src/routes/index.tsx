import { Suspense, useEffect, useState, type ReactNode } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { LayoutGrid, Plus, RotateCcw, X } from "lucide-react"

import { api, type DashboardData } from "@/lib/api"
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
  type WidgetId,
} from "@/components/dashboard/catalog"

export const Route = createFileRoute("/")({ component: Dashboard })

const LS_KEY = "danbyte-dashboard-widgets"

function loadLayout(): WidgetId[] {
  if (typeof window === "undefined") return DEFAULT_LAYOUT
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const ids = JSON.parse(raw) as WidgetId[]
    const valid = ids.filter((id) => id in CATALOG_BY_ID)
    return valid.length ? valid : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
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

  const [layout, setLayout] = useState<WidgetId[]>(DEFAULT_LAYOUT)
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    setLayout(loadLayout())
    setHydrated(true)
  }, [])
  const persist = (next: WidgetId[]) => {
    setLayout(next)
    window.localStorage.setItem(LS_KEY, JSON.stringify(next))
  }
  const add = (id: WidgetId) => !layout.includes(id) && persist([...layout, id])
  const remove = (id: WidgetId) => persist(layout.filter((x) => x !== id))
  const reset = () => persist(DEFAULT_LAYOUT)

  const d = q.data
  const available = CATALOG.filter((w) => !layout.includes(w.id))

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
            <Button variant="ghost" size="sm" onClick={reset}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
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

        {/* Masonry: cards size to content and pack tightly — no dead space. */}
        {d && hydrated && (
          <div className="gap-4 [column-fill:_balance] sm:columns-2 xl:columns-3 [&>*]:mb-4">
            {layout.map((id) => {
              const w = CATALOG_BY_ID[id]
              if (!w) return null
              return (
                <Tile
                  key={id}
                  title={w.title}
                  description={w.description}
                  onRemove={() => remove(id)}
                >
                  {w.render(d)}
                </Tile>
              )
            })}
            {layout.length === 0 && (
              <div className="flex break-inside-avoid flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
                <LayoutGrid className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No widgets. Use{" "}
                  <span className="font-medium">Add widget</span> to build your
                  dashboard.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** A content-sized widget card that won't split across masonry columns. */
function Tile({
  title,
  description,
  onRemove,
  children,
}: {
  title: string
  description: string
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div className="group/tile relative break-inside-avoid overflow-hidden rounded-lg border border-border bg-card p-3.5">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {description}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/tile:opacity-100 hover:bg-muted hover:text-foreground"
          title="Remove widget"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Suspense
        fallback={<div className="h-32 animate-pulse rounded-md bg-muted/40" />}
      >
        {children}
      </Suspense>
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
      value: d.reachable_pct != null ? `${d.reachable_pct}%` : "—",
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
