import { useEffect, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Check, LayoutGrid, Pencil, RotateCcw } from "lucide-react"

import { api, type DashboardData } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import type { WidgetId } from "@/components/dashboard/catalog"
import {
  AddWidgetMenu,
  DashboardGrid,
  StatBand,
  builtinLayout,
  metaForItem,
  withWidget,
} from "@/components/dashboard/board"
import {
  normalizeLayout,
  packItems,
  type DashItem,
} from "@/lib/dashboard-layout"
import { usePageTitle } from "@/lib/page-title"
import {
  DashboardSwitcher,
  NamedBoard,
} from "@/components/dashboard/named-board"

export const Route = createFileRoute("/")({
  component: Dashboard,
  // `own=1`: the user's own layout even when a named dashboard is their home.
  validateSearch: (s: Record<string, unknown>): { own?: "1" } =>
    s.own === "1" || s.own === 1 ? { own: "1" } : {},
})

const LS_KEY = "danbyte-dashboard-widgets"

/** The locally cached layout - accepts the old v1 id array AND v2, so an
 * existing user's arrangement upgrades in place instead of resetting. */
function loadLocalLayout(): DashItem[] | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    return raw
      ? normalizeLayout(JSON.parse(raw), metaForItem, builtinLayout())
      : null
  } catch {
    return null
  }
}

/** "/" - the dashboard a user picked as theirs, else their own layout. */
function Dashboard() {
  const home = useQuery({
    queryKey: ["dashboard-home"],
    queryFn: () => api<{ id: string | null }>("/api/dashboards/home/"),
    staleTime: 60_000,
  })
  const { own } = Route.useSearch()
  if (home.isLoading) return null
  if (home.data?.id && !own)
    return <NamedBoard key={home.data.id} id={home.data.id} />
  return <OwnDashboard />
}

function OwnDashboard() {
  usePageTitle("Dashboard")
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
    const server = normalizeLayout(
      pref.data?.data,
      metaForItem,
      builtinLayout()
    )
    if (server) {
      setItems(server)
    } else {
      const local = loadLocalLayout()
      if (local) {
        setItems(local)
        void putServer(local) // one-time adoption of the pre-server layout
      } else {
        const tenantDefault = normalizeLayout(
          q.data.default_widgets,
          metaForItem,
          builtinLayout()
        )
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
      window.localStorage.setItem(LS_KEY, JSON.stringify({ v: 2, items: next }))
    } catch {
      /* storage blocked */
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void putServer(next), 400)
  }

  const add = (id: WidgetId) => persist(withWidget(items, id))
  const remove = (id: string) => persist(items.filter((x) => x.id !== id))
  const reset = async () => {
    // A debounced save from a moments-ago edit must not fire AFTER the
    // delete and quietly resurrect the layout being reset.
    if (saveTimer.current) clearTimeout(saveTimer.current)
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
    const tenantDefault = normalizeLayout(
      q.data?.default_widgets,
      metaForItem,
      builtinLayout()
    )
    setItems(tenantDefault ?? builtinLayout())
  }

  // Re-pack the current widgets, keeping their sizes and settings: dragging
  // only compacts vertically, so holes accumulate - this closes them in one
  // click without resetting anything.
  const tidy = () => {
    const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
    persist(
      packItems(
        ordered.map((it) => ({
          id: it.id,
          w: it.w,
          h: it.h,
          maxW: metaForItem(it.id).max.w,
          minW: metaForItem(it.id).min.w,
          config: it.config,
        }))
      )
    )
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

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-4 p-4 md:p-6">
        <header className="flex flex-wrap items-center gap-3">
          <div>
            <DashboardSwitcher current={null} />
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
              <Button variant="ghost" size="sm" onClick={tidy}>
                <LayoutGrid className="h-3.5 w-3.5" /> Tidy
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
            {editing && <AddWidgetMenu items={items} onAdd={add} />}
          </div>
        </header>

        {q.isError && <QueryError error={q.error} />}

        {d && <StatBand d={d} />}

        {/* The widget grid (react-grid-layout, #41): drag the handle to
            move, drag the corner to resize - both snap to grid cells and only
            in edit mode. Vertical compaction keeps it gap-free. */}
        {d && hydrated && (
          <DashboardGrid
            items={items}
            editing={editing}
            interacting={interacting}
            setInteracting={setInteracting}
            persist={persist}
            remove={remove}
            d={d}
          />
        )}
        {d && hydrated && items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
            <LayoutGrid className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No widgets. Use <span className="font-medium">Add widget</span> to
              build your dashboard.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
