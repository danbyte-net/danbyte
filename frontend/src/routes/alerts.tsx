import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import {
  BellRing,
  BellOff,
  Check,
  Activity,
  ArrowUpCircle,
  Search,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AlertLifecycle,
  type AlertSeverity,
  type AlertsResponse,
  type MonitoringAlert,
  type Paginated,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { AlertRulesList } from "@/components/monitoring/alert-rules"
import { ChannelsList } from "@/components/monitoring/channels-list"
import { SilencesList } from "@/components/monitoring/silences-list"
import { apiErrorToast } from "@/lib/api-toast"

type AlertsTab = "alerts" | "rules" | "channels" | "silences"
type AckFilter = "all" | "acknowledged" | "unacknowledged"
interface AlertsSearch {
  tab: AlertsTab
  state: AlertLifecycle
  severity: AlertSeverity | "all"
  ack: AckFilter
  q: string
  site: string
}

export const Route = createFileRoute("/alerts")({
  component: AlertsPage,
  validateSearch: (s: Record<string, unknown>): AlertsSearch => ({
    tab: ["rules", "channels", "silences"].includes(s.tab as string)
      ? (s.tab as AlertsTab)
      : "alerts",
    state: s.state === "resolved" ? "resolved" : "firing",
    severity: ["critical", "warning", "info"].includes(s.severity as string)
      ? (s.severity as AlertSeverity)
      : "all",
    ack: ["acknowledged", "unacknowledged"].includes(s.ack as string)
      ? (s.ack as AckFilter)
      : "all",
    q: typeof s.q === "string" ? s.q : "",
    site: typeof s.site === "string" ? s.site : "all",
  }),
})

const SEV_VARIANT: Record<
  AlertSeverity,
  "destructive" | "warning" | "secondary"
> = {
  critical: "destructive",
  warning: "warning",
  info: "secondary",
}

function AlertsPage() {
  const { tab, state, severity, ack, q: search, site } = Route.useSearch()
  const nav = useNavigate()
  const go = (next: Partial<AlertsSearch>) =>
    nav({
      to: "/alerts",
      search: (prev): AlertsSearch => ({
        tab: next.tab ?? (prev.tab as AlertsTab) ?? "alerts",
        state: next.state ?? (prev.state as AlertLifecycle) ?? "firing",
        severity:
          next.severity ?? (prev.severity as AlertSeverity | "all") ?? "all",
        ack: next.ack ?? (prev.ack as AckFilter) ?? "all",
        q: next.q ?? (prev.q as string) ?? "",
        site: next.site ?? (prev.site as string) ?? "all",
      }),
      replace: next.q !== undefined, // typing shouldn't spam history
    })

  // Debounce the search box → URL, so each keystroke doesn't refetch.
  const [searchDraft, setSearchDraft] = useState(search)
  useEffect(() => setSearchDraft(search), [search])
  useEffect(() => {
    if (searchDraft === search) return
    const t = setTimeout(() => go({ q: searchDraft }), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft])

  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?picker=1"),
    staleTime: 10 * 60_000,
    enabled: tab === "alerts",
  })

  const q = useQuery({
    queryKey: ["alerts", state, severity, ack, search, site],
    queryFn: () => {
      const p = new URLSearchParams({ status: state })
      if (severity !== "all") p.set("severity", severity)
      if (ack !== "all") p.set("ack", ack)
      if (search) p.set("q", search)
      if (site !== "all") p.set("site", site)
      return api<AlertsResponse>(`/api/monitoring/alerts/?${p}`)
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled: tab === "alerts",
  })

  const counts = q.data?.counts ?? {}
  const rows = q.data?.results ?? []

  return (
    <div className="flex h-full flex-1 flex-col bg-muted/30">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border bg-background px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <BellRing className="h-4 w-4 text-muted-foreground" />
          Alerts
        </h1>
        <SegmentedTabs
          className="ml-2"
          value={tab}
          onValueChange={(v) => go({ tab: v as AlertsTab })}
          items={[
            { value: "alerts", label: "Alerts" },
            { value: "rules", label: "Rules" },
            { value: "channels", label: "Channels" },
            { value: "silences", label: "Silences" },
          ]}
        />
        {tab === "alerts" && (counts.firing ?? 0) > 0 && (
          <Badge variant="destructive" className="ml-auto">
            {counts.firing} firing
          </Badge>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        {tab === "silences" ? (
          <div className="mx-auto max-w-6xl">
            <SilencesList />
          </div>
        ) : tab === "channels" ? (
          <div className="mx-auto max-w-6xl">
            <ChannelsList />
          </div>
        ) : tab === "rules" ? (
          <div className="mx-auto max-w-6xl">
            <AlertRulesList />
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-3">
            {/* Firing / Resolved + severity + ack + search + site filters */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                {(["firing", "resolved"] as const).map((s) => (
                  <FilterButton
                    key={s}
                    active={state === s}
                    onClick={() => go({ state: s })}
                    label={s === "firing" ? "Firing" : "Resolved"}
                    count={counts[s]}
                  />
                ))}
              </div>
              <span className="mx-1 h-4 w-px bg-border" />
              <div className="flex items-center gap-1">
                {(["all", "critical", "warning", "info"] as const).map((sv) => (
                  <FilterButton
                    key={sv}
                    active={severity === sv}
                    onClick={() => go({ severity: sv })}
                    label={sv[0].toUpperCase() + sv.slice(1)}
                    count={sv === "all" ? undefined : counts[sv]}
                  />
                ))}
              </div>
              <span className="mx-1 h-4 w-px bg-border" />
              <div className="flex items-center gap-1">
                {(
                  [
                    ["all", "Any ack"],
                    ["unacknowledged", "Unacked"],
                    ["acknowledged", "Acked"],
                  ] as const
                ).map(([v, label]) => (
                  <FilterButton
                    key={v}
                    active={ack === v}
                    onClick={() => go({ ack: v })}
                    label={label}
                    count={v === "acknowledged" ? counts.acknowledged : undefined}
                  />
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <select
                  value={site}
                  onChange={(e) => go({ site: e.target.value })}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  aria-label="Filter by site"
                >
                  <option value="all">All sites</option>
                  {(sites.data?.results ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    placeholder="IP, description, rule…"
                    className="h-8 w-56 pl-7 text-xs"
                  />
                </div>
              </div>
            </div>

            {q.isError && <QueryError error={q.error} />}

            <AlertsTable rows={rows} emptyState={state} loaded={!!q.data} />
          </div>
        )}
      </div>
    </div>
  )
}

function AlertsTable({
  rows,
  emptyState,
  loaded,
}: {
  rows: MonitoringAlert[]
  emptyState: AlertLifecycle
  loaded: boolean
}) {
  const columns: ColumnDef<MonitoringAlert>[] = [
    {
      id: "severity",
      accessorFn: (a) => a.severity,
      header: ({ column }) => <SortHeader column={column} label="Severity" />,
      cell: ({ row }) => (
        <Badge
          variant={SEV_VARIANT[row.original.severity]}
          className="capitalize"
        >
          {row.original.severity}
        </Badge>
      ),
    },
    {
      id: "ip",
      accessorFn: (a) => a.target_ip.ip_address,
      header: ({ column }) => <SortHeader column={column} label="IP address" />,
      cell: ({ row }) => (
        <Link
          to="/ips/$id"
          params={{ id: row.original.target_ip.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.target_ip.ip_address}
        </Link>
      ),
    },
    {
      id: "check",
      accessorFn: (a) => a.template?.name ?? a.kind,
      header: "Check",
      cell: ({ row }) => (
        <>
          {row.original.template?.name ?? row.original.kind}{" "}
          <span className="font-mono text-[11px] text-muted-foreground uppercase">
            {row.original.kind}
          </span>
        </>
      ),
    },
    {
      id: "state",
      enableSorting: false,
      header: "State",
      cell: ({ row }) => {
        const a = row.original
        return (
          <div className="flex items-center gap-1.5">
            <CheckStatusBadge status={a.check_status} />
            {a.escalated && (
              <Badge
                variant="destructive"
                className="gap-1 text-[10px]"
                title="Escalated to critical after firing unacknowledged"
              >
                <ArrowUpCircle className="h-3 w-3" /> escalated
              </Badge>
            )}
            {a.flapping && (
              <Badge
                variant="warning"
                className="gap-1 text-[10px]"
                title="Condition is opening/clearing repeatedly — renotify paused"
              >
                <Activity className="h-3 w-3" /> flapping
              </Badge>
            )}
            {a.silenced && (
              <Badge
                variant="secondary"
                className="gap-1 text-[10px]"
                title="Muted by an active silence / maintenance window"
              >
                <BellOff className="h-3 w-3" /> silenced
              </Badge>
            )}
            {a.acknowledged && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px]"
                title={
                  (a.acknowledged_by_name
                    ? `by ${a.acknowledged_by_name}`
                    : "") + (a.ack_note ? ` — ${a.ack_note}` : "")
                }
              >
                <Check className="h-3 w-3" /> ack
              </Badge>
            )}
          </div>
        )
      },
    },
    timeAgoColumn<MonitoringAlert>({
      id: "opened",
      header: "Opened",
      get: (a) => a.opened_at,
      align: "right",
    }),
    {
      id: "duration",
      enableSorting: false,
      header: () => <div className="text-right">Duration</div>,
      cell: ({ row }) => {
        const a = row.original
        const end = a.resolved_at ? new Date(a.resolved_at) : new Date()
        const ms = end.getTime() - new Date(a.opened_at).getTime()
        return (
          <div className="num text-right text-muted-foreground">
            {humanDuration(ms)}
          </div>
        )
      },
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: "",
      cell: ({ row }) => <AlertRowActions a={row.original} />,
    },
  ]

  if (loaded && rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
        {emptyState === "firing"
          ? "No firing alerts — all clear."
          : "No resolved alerts."}
      </div>
    )
  }

  return (
    <DataTable
      tableId="alerts"
      data={rows}
      columns={columns}
      flexColumn="check"
    />
  )
}

function AlertRowActions({ a }: { a: MonitoringAlert }) {
  const qc = useQueryClient()

  const ack = useMutation({
    mutationFn: (unack: boolean) =>
      api<MonitoringAlert>(
        `/api/monitoring/alerts/${a.id}/ack/${unack ? "?action=unack" : ""}`,
        { method: "POST", body: JSON.stringify({}) }
      ),
    onSuccess: (_d, unack) => {
      toast.success(unack ? "Acknowledgement cleared" : "Alert acknowledged")
      qc.invalidateQueries({ queryKey: ["alerts"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  if (a.status !== "firing") return null

  return (
    <RowActions
      extra={
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title={a.acknowledged ? "Clear acknowledgement" : "Acknowledge"}
          disabled={ack.isPending}
          onClick={() => ack.mutate(a.acknowledged)}
        >
          {a.acknowledged ? (
            <BellOff className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">{a.acknowledged ? "Unack" : "Ack"}</span>
        </Button>
      }
    />
  )
}

function FilterButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
      {count != null && (
        <span
          className={`num text-[11px] ${
            active ? "text-background/70" : "text-muted-foreground/70"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
