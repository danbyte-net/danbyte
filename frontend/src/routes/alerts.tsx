import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { BellOff, Check, Activity, ArrowUpCircle } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AlertLifecycle,
  type AlertSeverity,
  type AlertsResponse,
  type MonitoringAlert,
  type Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import { FacetGroup, FilterRail } from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { AlertRulesList } from "@/components/monitoring/alert-rules"
import { PortRulesList } from "@/components/monitoring/port-rules"
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
  kind?: string
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
    kind: typeof s.kind === "string" ? s.kind : "",
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

// Stable empty selection for the single-select rail facets.
const EMPTY_FACET: Set<string> = new Set()

function AlertsPage() {
  const { tab, state, severity, ack, q: search, site, kind } = Route.useSearch()
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
        kind: next.kind ?? (prev.kind as string) ?? "",
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
    queryKey: ["alerts", state, severity, ack, search, site, kind],
    queryFn: () => {
      const p = new URLSearchParams({ status: state })
      if (severity !== "all") p.set("severity", severity)
      if (ack !== "all") p.set("ack", ack)
      if (search) p.set("q", search)
      if (site !== "all") p.set("site", site)
      if (kind) p.set("kind", kind)
      return api<AlertsResponse>(`/api/monitoring/alerts/?${p}`)
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled: tab === "alerts",
  })

  const counts = q.data?.counts ?? {}
  const rows = q.data?.results ?? []

  // Severity + ack are single-select and server-side; the rail's "clear" is
  // what widens each one back to "any". Counts are the server's own aggregates
  // (firing-scoped, exactly the numbers the old chips showed).
  const acked = counts.acknowledged ?? 0
  const firing = counts.firing ?? 0
  const rail = (
    <FilterRail>
      <FacetGroup
        label="Severity"
        options={(["critical", "warning", "info"] as const).map((sv) => ({
          value: sv,
          label: sv[0].toUpperCase() + sv.slice(1),
          count: counts[sv] ?? 0,
        }))}
        selected={severity === "all" ? EMPTY_FACET : new Set([severity])}
        onToggle={(v) =>
          go({ severity: v === severity ? "all" : (v as AlertSeverity) })
        }
      />
      <FacetGroup
        label="Acknowledged"
        options={[
          { value: "unacknowledged", label: "Unacked", count: firing - acked },
          { value: "acknowledged", label: "Acked", count: acked },
        ]}
        selected={ack === "all" ? EMPTY_FACET : new Set([ack])}
        onToggle={(v) => go({ ack: v === ack ? "all" : (v as AckFilter) })}
      />
    </FilterRail>
  )

  const secondaryTab =
    tab === "rules" ? (
      <div className="space-y-8">
        <AlertRulesList />
        <PortRulesList />
      </div>
    ) : tab === "channels" ? (
      <ChannelsList />
    ) : tab === "silences" ? (
      <SilencesList />
    ) : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={(v) => go({ tab: v as AlertsTab })}
          items={[
            { value: "alerts", label: "Alerts" },
            { value: "rules", label: "Rules" },
            { value: "channels", label: "Channels" },
            { value: "silences", label: "Silences" },
          ]}
        />
      </div>

      {secondaryTab ? (
        <ListPageShell title="Alerts">{secondaryTab}</ListPageShell>
      ) : (
        <ListPageShell
          title="Alerts"
          count={q.data ? rows.length : undefined}
          rail={rail}
          search={{
            value: searchDraft,
            onChange: setSearchDraft,
            placeholder: "IP, description, rule…",
          }}
          actions={
            <>
              {/* Lifecycle is an either/or split of the whole list (never
                  "any"), so it stays a segmented switch rather than a facet. */}
              <SegmentedTabs<AlertLifecycle>
                value={state}
                onValueChange={(v) => go({ state: v })}
                items={[
                  { value: "firing", label: "Firing", count: counts.firing },
                  {
                    value: "resolved",
                    label: "Resolved",
                    count: counts.resolved,
                  },
                ]}
              />
              <Select value={site} onValueChange={(v) => go({ site: v })}>
                <SelectTrigger
                  className="h-8 w-40 text-xs"
                  aria-label="Filter by site"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sites</SelectItem>
                  {(sites.data?.results ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          }
          query={q}
        >
          <AlertsTable rows={rows} />
        </ListPageShell>
      )}
    </div>
  )
}

function AlertsTable({ rows }: { rows: MonitoringAlert[] }) {
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
          className="link font-mono font-medium"
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
                title="Condition is opening/clearing repeatedly - renotify paused"
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
                    : "") + (a.ack_note ? ` - ${a.ack_note}` : "")
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
    // Ack / unack is the only row action alerts have - it rides the shared
    // actions column's `extra` slot instead of a bespoke cell.
    actionsColumn<MonitoringAlert>({
      extra: (a) => (a.status === "firing" ? <AckButton a={a} /> : null),
    }),
  ]

  return (
    <DataTable
      tableId="alerts"
      data={rows}
      columns={columns}
      flexColumn="check"
    />
  )
}

/** Acknowledge / clear-acknowledgement toggle for one firing alert. */
function AckButton({ a }: { a: MonitoringAlert }) {
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

  return (
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
