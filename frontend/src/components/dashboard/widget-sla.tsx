import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  ExploreDimension,
  ExploreResponse,
  LatencyPageResponse,
  MaintenanceEvent,
  Paginated,
  SlaAgreement,
} from "@/lib/api"
import { TimeCell } from "@/components/cells/time-ago"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { StatusBadge } from "@/components/status-badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AvailabilityCell,
  fmtMs,
  fmtPct,
} from "@/components/monitoring/availability"
import {
  SLA_STATE_LABEL,
  SlaFigureBadge,
  fmtBudget,
  fmtSla,
} from "@/components/monitoring/sla-figure"

// Widgets that read monitoring figures for a named dashboard's scope. Each
// fetches its own data: `scope` is the board's "site=…&frame=30d", and the
// figure endpoints take the same dimension params the checks list does.

/** A board's frame ("frame=30d") as the figure endpoints' window. */
function windowQuery(scope: string): string {
  const p = new URLSearchParams(scope)
  const frame = p.get("frame") ?? "7d"
  p.delete("frame")
  if (frame === "24h") p.set("hours", "24")
  else p.set("days", frame.replace("d", ""))
  return p.toString()
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[80px] items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function useAgreements() {
  return useQuery({
    queryKey: ["sla-agreements", "widget"],
    queryFn: () =>
      api<Paginated<SlaAgreement>>(
        "/api/monitoring/sla-agreements/?page_size=200&status=active"
      ),
    staleTime: 60_000,
  })
}

/** One agreement's figure against its target, with the budget as a bar. */
export function SlaHeadlineWidget({
  config,
  setConfig,
  editing,
}: {
  config?: Record<string, unknown>
  setConfig: (c: Record<string, unknown>) => void
  editing: boolean
}) {
  const q = useAgreements()
  const rows = q.data?.results ?? []
  const picked =
    rows.find((a) => a.id === config?.agreement) ??
    (config?.agreement ? undefined : rows.at(0))
  const f = picked?.current?.figures
  return (
    <div className="flex h-full flex-col gap-3">
      {editing && (
        <Select
          value={picked?.id ?? ""}
          onValueChange={(v) => setConfig({ agreement: v })}
        >
          <SelectTrigger size="sm" aria-label="Agreement">
            <SelectValue placeholder="Pick an agreement" />
          </SelectTrigger>
          <SelectContent>
            {rows.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!picked ? (
        <Muted>{q.isLoading ? "Loading..." : "No agreement."}</Muted>
      ) : !f ? (
        <Muted>Not computed yet.</Muted>
      ) : (
        <div className="flex flex-1 flex-col justify-center gap-2">
          <Link
            to="/monitoring/sla/$id"
            params={{ id: picked.id }}
            className="link truncate text-[13px] font-medium"
          >
            {picked.name}
          </Link>
          <div className="flex items-baseline gap-2">
            <SlaFigureBadge figures={f} />
            <span className="text-xs text-muted-foreground">
              of {fmtSla(f.target)} · {SLA_STATE_LABEL[f.state]}
            </span>
          </div>
          {/* Budget spent against the period elapsed: past the marker is
              spending faster than time passes. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/monitoring/sla/$id"
                params={{ id: picked.id }}
                className="relative block h-2.5 rounded-sm bg-muted"
                aria-label={`${f.budget_spent_pct}% of the budget spent, ${f.elapsed_pct}% of the period gone`}
              >
                <span
                  className={`block h-full rounded-sm ${f.budget_left_s < 0 ? "bg-red-500" : f.state === "at_risk" ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${Math.min(100, f.budget_spent_pct)}%` }}
                />
                <span
                  className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
                  style={{ left: `${Math.min(100, f.elapsed_pct)}%` }}
                />
              </Link>
            </TooltipTrigger>
            <TooltipContent>
              <span className="num">
                Budget {f.budget_spent_pct}% spent · the marker is{" "}
                {f.elapsed_pct}% of the period gone
              </span>
            </TooltipContent>
          </Tooltip>
          <div className="text-[11px] text-muted-foreground">
            Budget left {fmtBudget(f.budget_left_s)} · {f.budget_spent_pct}%
            spent, {f.elapsed_pct}% of the period gone
            {f.coverage != null && ` · ${Math.round(f.coverage)}% measured`}
          </div>
        </div>
      )}
    </div>
  )
}

/** Every active agreement with this period's figure and budget. */
export function SlaTableWidget() {
  const q = useAgreements()
  const rows = q.data?.results ?? []
  if (!rows.length)
    return <Muted>{q.isLoading ? "Loading..." : "No agreements."}</Muted>
  return (
    <ul className="divide-y divide-border text-[13px]">
      {rows.map((a) => {
        const f = a.current?.figures
        return (
          <li key={a.id} className="flex items-center gap-2 py-1.5">
            <Link
              to="/monitoring/sla/$id"
              params={{ id: a.id }}
              className="link min-w-0 flex-1 truncate"
            >
              {a.name}
            </Link>
            <SlaFigureBadge figures={f} />
            <span
              className={`num w-16 text-right text-xs ${f && f.budget_left_s < 0 ? "text-destructive" : "text-muted-foreground"}`}
            >
              {f ? fmtBudget(f.budget_left_s) : "-"}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const GROUPS: { value: ExploreDimension; label: string }[] = [
  { value: "site", label: "Site" },
  { value: "role", label: "Role" },
  { value: "device_type", label: "Device type" },
  { value: "kind", label: "Check type" },
]

/** Availability per site, role, type or check kind, worst first. */
export function AvailabilityByGroupWidget({
  config,
  setConfig,
  editing,
  scope = "",
}: {
  config?: Record<string, unknown>
  setConfig: (c: Record<string, unknown>) => void
  editing: boolean
  scope?: string
}) {
  const groupBy = GROUPS.some((g) => g.value === config?.group_by)
    ? (config!.group_by as ExploreDimension)
    : "site"
  const q = useQuery({
    queryKey: ["dash-explore", groupBy, scope],
    queryFn: () =>
      api<ExploreResponse>(
        `/api/monitoring/explore/?group_by=${groupBy}&${windowQuery(scope)}`
      ),
    staleTime: 60_000,
  })
  const rows = (q.data?.rows ?? []).filter((r) => r.availability != null)
  return (
    <div className="flex h-full flex-col gap-2">
      {editing && (
        <Select
          value={groupBy}
          onValueChange={(v) => setConfig({ group_by: v })}
        >
          <SelectTrigger size="sm" aria-label="Group by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUPS.map((g) => (
              <SelectItem key={g.value} value={g.value}>
                {g.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!rows.length ? (
        <Muted>{q.isLoading ? "Loading..." : "Nothing measured."}</Muted>
      ) : (
        <ul className="space-y-1 text-[13px]">
          {rows.map((r) => (
            <li key={r.key ?? "none"} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {r.name ?? "None"}
              </span>
              <AvailabilityCell figures={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The checks furthest from their own usual latency. */
export function TopOffendersWidget({ scope = "" }: { scope?: string }) {
  const q = useQuery({
    queryKey: ["dash-latency", scope],
    queryFn: () =>
      api<LatencyPageResponse>(
        `/api/monitoring/latency/?${windowQuery(scope)}`
      ),
    staleTime: 60_000,
  })
  const rows = q.data?.slowest ?? []
  if (!rows.length)
    return (
      <Muted>{q.isLoading ? "Loading..." : "Nothing off its normal."}</Muted>
    )
  return (
    <ul className="divide-y divide-border text-[13px]">
      {rows.slice(0, 10).map((r) => (
        <li key={r.id} className="flex items-center gap-2 py-1.5">
          <Link
            to="/monitoring/checks/$id"
            params={{ id: r.id }}
            className="link min-w-0 flex-1 truncate"
          >
            <span className="font-mono">{r.target_ip.ip_address}</span> ·{" "}
            {r.template.name}
          </Link>
          <span className="num text-xs text-muted-foreground">
            {fmtMs(r.figures.p95)}
          </span>
          <span className="num w-10 text-right text-xs font-medium">
            {r.ratio != null ? `${r.ratio.toFixed(1)}x` : "-"}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** How much of the scope's time was actually measured, per check kind. */
export function CoverageWidget({ scope = "" }: { scope?: string }) {
  const q = useQuery({
    queryKey: ["dash-explore", "kind", scope],
    queryFn: () =>
      api<ExploreResponse>(
        `/api/monitoring/explore/?group_by=kind&${windowQuery(scope)}`
      ),
    staleTime: 60_000,
  })
  const rows = q.data?.rows ?? []
  const seen = rows.reduce((n, r) => n + r.up_s + r.down_s, 0)
  const all = rows.reduce((n, r) => n + r.up_s + r.down_s + r.unmeasured_s, 0)
  if (!all) return <Muted>{q.isLoading ? "Loading..." : "No checks."}</Muted>
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <div className="text-3xl font-semibold tracking-tight">
        {fmtPct((100 * seen) / all)}
      </div>
      <ul className="space-y-1 text-[12px]">
        {rows.map((r) => (
          <li key={r.key ?? "none"} className="flex items-center gap-2">
            <span className="w-14 font-mono text-[11px] uppercase">
              {r.name}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted">
              <span
                className="block h-full bg-emerald-500"
                style={{ width: `${r.coverage ?? 0}%` }}
              />
            </span>
            <span className="num w-10 text-right text-muted-foreground">
              {r.coverage == null ? "-" : `${Math.round(r.coverage)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Maintenance and outages not yet closed, soonest first. */
export function UpcomingMaintenanceWidget() {
  const q = useQuery({
    queryKey: ["maintenance-events", "widget"],
    queryFn: () =>
      api<Paginated<MaintenanceEvent>>(
        "/api/monitoring/maintenance-events/?open=1&page_size=50"
      ),
    staleTime: 60_000,
  })
  const rows = [...(q.data?.results ?? [])].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at)
  )
  if (!rows.length)
    return <Muted>{q.isLoading ? "Loading..." : "Nothing planned."}</Muted>
  return (
    <ul className="divide-y divide-border text-[13px]">
      {rows.slice(0, 12).map((e) => (
        <li key={e.id} className="flex items-center gap-2 py-1.5">
          <StatusBadge status={e.status} />
          <Link
            to="/maintenance/$id/edit"
            params={{ id: e.id }}
            className="link min-w-0 flex-1 truncate"
          >
            {e.name}
          </Link>
          <TimeCell iso={e.starts_at} />
        </li>
      ))}
    </ul>
  )
}
