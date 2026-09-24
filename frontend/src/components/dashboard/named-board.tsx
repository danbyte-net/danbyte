import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  Copy,
  Home,
  LayoutGrid,
  Monitor,
  Pencil,
  Settings2,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DashboardData, NamedDashboard, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { normalizeLayout, packItems } from "@/lib/dashboard-layout"
import type { DashItem } from "@/lib/dashboard-layout"
import { usePageTitle } from "@/lib/page-title"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { QueryError } from "@/components/query-error"
import type { WidgetId } from "./catalog"
import {
  AddWidgetMenu,
  DashboardGrid,
  StatBand,
  metaForItem,
  withWidget,
} from "./board"
import { DashboardSettingsDialog, scopeQuery } from "./dashboard-settings"

/** Switch between the home layout and every dashboard you can see. */
export function DashboardSwitcher({ current }: { current: string | null }) {
  const q = useQuery({
    queryKey: ["dashboards"],
    queryFn: () =>
      api<Paginated<NamedDashboard>>("/api/dashboards/?page_size=200"),
    staleTime: 60_000,
  })
  const rows = q.data?.results ?? []
  const name = current
    ? (rows.find((d) => d.id === current)?.name ?? "Dashboard")
    : "Dashboard"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight hover:text-foreground/80"
        >
          {name}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem asChild>
          <Link to="/" search={{ own: "1" }}>
            My dashboard
          </Link>
        </DropdownMenuItem>
        {rows.length > 0 && <DropdownMenuSeparator />}
        {rows.map((d) => (
          <DropdownMenuItem key={d.id} asChild>
            <Link to="/dashboards/$id" params={{ id: d.id }}>
              {d.name}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/dashboards">All dashboards</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One named dashboard. `tv` drops the page chrome for a wall screen and, with
 * `cycle`, moves on to the next dashboard every `every` seconds.
 */
export function NamedBoard({
  id,
  tv = false,
  cycle = [],
  every = 60,
}: {
  id: string
  tv?: boolean
  cycle?: string[]
  every?: number
}) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["named-dashboard", id],
    queryFn: () => api<NamedDashboard>(`/api/dashboards/${id}/`),
  })
  const board = q.data
  usePageTitle(board?.name ?? "Dashboard")
  const scope = board ? scopeQuery(board) : ""
  const data = useQuery({
    queryKey: ["dashboard", scope],
    queryFn: () => api<DashboardData>(`/api/dashboard/?${scope}`),
    enabled: !!board,
    refetchInterval: board?.refresh_seconds
      ? board.refresh_seconds * 1000
      : false,
  })
  // Widgets that fetch their own data refresh on the same beat.
  useEffect(() => {
    if (!board?.refresh_seconds) return
    const t = setInterval(() => {
      for (const key of [
        "sla-agreements",
        "dash-explore",
        "dash-latency",
        "maintenance-events",
      ])
        qc.invalidateQueries({ queryKey: [key] })
    }, board.refresh_seconds * 1000)
    return () => clearInterval(t)
  }, [board?.refresh_seconds, qc])

  // TV: the next board in the cycle after `every` seconds.
  useEffect(() => {
    if (!tv || cycle.length < 2) return
    const t = setTimeout(() => {
      const next = cycle[(cycle.indexOf(id) + 1) % cycle.length]
      nav({
        to: "/dashboards/$id",
        params: { id: next },
        search: { tv: "1", cycle: cycle.join(","), every: String(every) },
      })
    }, every * 1000)
    return () => clearTimeout(t)
  }, [tv, cycle, every, id, nav])

  const [items, setItems] = useState<DashItem[]>([])
  const [editing, setEditing] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [settings, setSettings] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (!board) return
    setItems(normalizeLayout(board.layout, metaForItem, []) ?? [])
  }, [board])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persist = (next: DashItem[]) => {
    setItems(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api(`/api/dashboards/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ layout: { v: 2, items: next } }),
      }).catch((e: unknown) => apiErrorToast(e))
    }, 400)
  }
  const tidy = () =>
    persist(
      packItems(
        [...items]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((it) => ({
            id: it.id,
            w: it.w,
            h: it.h,
            maxW: metaForItem(it.id).max.w,
            minW: metaForItem(it.id).min.w,
            config: it.config,
          }))
      )
    )

  const duplicate = useMutation({
    mutationFn: () =>
      api<NamedDashboard>(`/api/dashboards/${id}/duplicate/`, {
        method: "POST",
      }),
    onSuccess: (copy) => {
      toast.success(`Copied to ${copy.name}`)
      qc.invalidateQueries({ queryKey: ["dashboards"] })
      nav({ to: "/dashboards/$id", params: { id: copy.id } })
    },
    onError: (e) => apiErrorToast(e),
  })
  const homePick = useQuery({
    queryKey: ["dashboard-home"],
    queryFn: () => api<{ id: string | null }>("/api/dashboards/home/"),
    staleTime: 60_000,
  })
  const isHome = homePick.data?.id === id
  const home = useMutation({
    mutationFn: () =>
      api("/api/dashboards/home/", {
        method: "PUT",
        body: JSON.stringify({ id: isHome ? null : id }),
      }),
    onSuccess: () => {
      toast.success(
        isHome
          ? "Your own layout opens again"
          : "Opens when you go to the dashboard"
      )
      qc.invalidateQueries({ queryKey: ["dashboard-home"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const del = useMutation({
    mutationFn: () => api<void>(`/api/dashboards/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Dashboard deleted")
      qc.invalidateQueries({ queryKey: ["dashboards"] })
      nav({ to: "/dashboards" })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!board)
    return <p className="p-6 text-sm text-muted-foreground">Loading...</p>

  const tvSearch = {
    tv: "1",
    cycle: cycle.length ? cycle.join(",") : id,
    every: String(every),
  }
  const scoped = Object.values(board.scope).some((v) => v.length > 0)
  const d = data.data

  return (
    <div
      className={
        tv
          ? "fixed inset-0 z-50 overflow-auto bg-background p-4"
          : "min-h-0 flex-1 overflow-auto"
      }
    >
      <div className={tv ? "space-y-4" : "space-y-4 p-4 md:p-6"}>
        <header className="flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            {tv ? (
              <h1 className="text-2xl font-semibold tracking-tight">
                {board.name}
              </h1>
            ) : (
              <DashboardSwitcher current={id} />
            )}
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {board.description}
              {scoped && <Badge variant="secondary">Scoped</Badge>}
              <Badge variant="outline">{board.frame}</Badge>
              {!board.mine && <span>by {board.owner_name}</span>}
            </p>
          </div>
          {tv ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => nav({ to: "/dashboards/$id", params: { id } })}
            >
              Exit
            </Button>
          ) : (
            <div className="ml-auto flex items-center gap-2">
              {editing && (
                <AddWidgetMenu
                  items={items}
                  onAdd={(w: WidgetId) => persist(withWidget(items, w))}
                />
              )}
              {editing && (
                <Button variant="ghost" size="sm" onClick={tidy}>
                  <LayoutGrid className="h-3.5 w-3.5" /> Tidy
                </Button>
              )}
              {board.mine && (
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
              )}
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboards/$id" params={{ id }} search={tvSearch}>
                  <Monitor className="h-3.5 w-3.5" /> TV
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label="More">
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {board.mine && (
                    <DropdownMenuItem onClick={() => setSettings(true)}>
                      <Settings2 className="h-3.5 w-3.5" /> Settings
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => duplicate.mutate()}>
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => home.mutate()}>
                    <Home className="h-3.5 w-3.5" />{" "}
                    {isHome ? "Stop opening this one" : "Open as my dashboard"}
                  </DropdownMenuItem>
                  {board.mine && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleting(true)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </header>

        {data.isError && <QueryError error={data.error} />}
        {d && <StatBand d={d} />}
        {d && (
          <DashboardGrid
            items={items}
            editing={editing}
            interacting={interacting}
            setInteracting={setInteracting}
            persist={persist}
            remove={(wid) => persist(items.filter((x) => x.id !== wid))}
            d={d}
            scope={scope}
          />
        )}
        {d && items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
            <LayoutGrid className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {board.mine
                ? "No widgets yet. Edit layout to add some."
                : "No widgets yet."}
            </p>
          </div>
        )}
      </div>
      {board.mine && (
        <DashboardSettingsDialog
          dashboard={board}
          open={settings}
          onOpenChange={setSettings}
          onSaved={() => undefined}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${board.name}?`}
        description="Anyone it is shared with loses it too."
        confirmLabel="Delete"
        pendingLabel="Deleting..."
        destructive
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  )
}
