import { useEffect, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ListChecks, AlertTriangle, Cpu, Clock, RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import type {
  JobsResponse,
  JobBrief,
  SystemJobStatus,
  ScheduledResponse,
  ScheduledTask,
  EngineHeartbeat,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { FilterRail } from "@/components/filter-rail"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DataTable } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/jobs/")({ component: JobsPage })

type Variant = "secondary" | "info" | "success" | "destructive" | "warning"

// state → display label + badge tint. Kept here so the list + detail agree.
export const STATE_META: Record<
  string,
  { label: string; variant: Variant } | undefined
> = {
  queued: { label: "Queued", variant: "secondary" },
  started: { label: "Running", variant: "info" },
  deferred: { label: "Deferred", variant: "warning" },
  scheduled: { label: "Scheduled", variant: "secondary" },
  finished: { label: "Finished", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
}

// Dot colour per state — mirrors the badge variant, used in the filter rail.
const STATE_DOT: Record<Variant, string> = {
  secondary: "bg-zinc-400",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  destructive: "bg-red-500",
  warning: "bg-amber-500",
}

export function StateBadge({ state }: { state: string }) {
  const meta = STATE_META[state] ?? {
    label: state,
    variant: "secondary" as const,
  }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

// Run-log status → badge tint (Scheduled tasks section).
const RUN_VARIANT: Record<string, Variant> = {
  ok: "success",
  failed: "destructive",
  running: "info",
  skipped: "secondary",
}

function RunStatusBadge({ status }: { status: string }) {
  return <Badge variant={RUN_VARIANT[status] ?? "secondary"}>{status}</Badge>
}

// The periodic beat — systemd-timer oneshots that never touch RQ. Surfaced so
// admins can see each one ran and when (digest, discovery, Outpost driver, …).
function ScheduledTasksCard({ tasks }: { tasks: ScheduledTask[] }) {
  return (
    <section className="rounded-lg border border-border">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Scheduled tasks</h2>
        <span className="text-xs text-muted-foreground">
          the periodic beat — runs on a timer, outside the queue
        </span>
      </header>
      <div className="divide-y divide-border">
        {tasks.map((t) => (
          <div
            key={t.name}
            className="flex items-center gap-3 px-3 py-2 text-[13px]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t.label}</span>
                {t.cadence && (
                  <span className="text-[11px] text-muted-foreground">
                    {t.cadence}
                  </span>
                )}
                {t.last_run ? (
                  <RunStatusBadge status={t.last_run.status} />
                ) : (
                  <Badge variant="secondary">never run</Badge>
                )}
              </div>
              {t.last_run?.summary && (
                <div className="truncate text-xs text-muted-foreground">
                  {t.last_run.summary}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">
              {t.last_run ? <TimeCell iso={t.last_run.started_at} /> : "—"}
              {t.last_run?.duration_seconds != null && (
                <div className="text-[11px]">
                  {fmtDuration(t.last_run.duration_seconds)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// Where checks actually run — the local engine + any Outposts — with heartbeats.
function EnginesCard({ engines }: { engines: EngineHeartbeat[] }) {
  if (engines.length === 0) return null
  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Engines &amp; Outposts</h2>
        <span className="text-xs text-muted-foreground">
          check-run locations and their last heartbeat
        </span>
      </header>
      <div className="divide-y divide-border">
        {engines.map((e) => (
          <div key={e.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
            <span className="font-medium">{e.name}</span>
            <Badge variant={e.kind === "local" ? "secondary" : "info"}>
              {e.kind === "local" ? "Local" : "Outpost"}
            </Badge>
            {!e.enabled ? (
              <Badge variant="secondary">disabled</Badge>
            ) : e.stale_since ? (
              <Badge variant="destructive">stale</Badge>
            ) : e.last_seen_at ? (
              <Badge variant="success">online</Badge>
            ) : null}
            <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
              {e.last_seen_at ? (
                <>
                  last seen <TimeCell iso={e.last_seen_at} />
                </>
              ) : (
                "never seen"
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

// Seconds → compact human duration.
export function fmtDuration(s: number | null): string {
  if (s == null) return "—"
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Countdown formatting: whole seconds → "3m 20s" / "45s" / "any moment".
function fmtCountdown(sec: number): string {
  if (sec <= 0) return "any moment"
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// The self-upgrade can't be an RQ job (it restarts the workers), so it's shown
// here as a system entry: live progress while upgrading, otherwise the next
// auto-update countdown. Ticks locally every second for a smooth countdown.
function SystemUpgradeCard({ system }: { system: SystemJobStatus }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const up = system.upgrade
  const au = system.auto_update

  if (up.active) {
    const pct = up.pct ?? 0
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[13px]">
          <RefreshCw className="h-4 w-4 animate-spin text-primary" />
          <span className="font-medium">
            Upgrading Danbyte{up.version_to ? ` to ${up.version_to}` : ""}
          </span>
          <span className="text-muted-foreground">· {up.step ?? "…"}</span>
          <span className="ml-auto text-muted-foreground tabular-nums">
            {pct}%
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }

  if (up.state === "failed") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Last upgrade failed
          {up.error ? `: ${up.error}` : ""}. Danbyte was rolled back.
        </span>
      </div>
    )
  }

  if (au.enabled) {
    const remaining =
      au.next_check != null ? au.next_check - Date.now() / 1000 : null
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">Automatic updates on</span>
        {remaining != null && (
          <span className="ml-auto text-muted-foreground">
            Next check in{" "}
            <span className="text-foreground tabular-nums">
              {fmtCountdown(remaining)}
            </span>
          </span>
        )}
      </div>
    )
  }

  return null
}

const PAGE_SIZE = 50

const columns: ColumnDef<JobBrief>[] = [
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => <StateBadge state={row.original.state} />,
  },
  {
    id: "job",
    header: "Job",
    cell: ({ row }) => {
      const j = row.original
      return (
        <div>
          <div className="flex items-center gap-2">
            <Link
              to="/jobs/$id"
              params={{ id: j.id }}
              className="truncate font-mono text-[13px] font-medium hover:underline"
            >
              {j.func_short}
            </Link>
            {j.corrupt && (
              <Badge variant="warning" className="shrink-0">
                unreadable
              </Badge>
            )}
          </div>
          {j.description && (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {j.description}
            </div>
          )}
        </div>
      )
    },
  },
  {
    id: "queue",
    header: "Queue",
    cell: ({ row }) => (
      <span className="font-mono text-[11px] text-muted-foreground">
        {row.original.queue}
      </span>
    ),
  },
  {
    id: "worker",
    header: "Worker",
    cell: ({ row }) => (
      <span className="font-mono text-[11px] text-muted-foreground">
        {row.original.worker_name ? row.original.worker_name.slice(0, 12) : "—"}
      </span>
    ),
  },
  {
    id: "enqueued",
    header: "Enqueued",
    cell: ({ row }) =>
      row.original.enqueued_at ? (
        <TimeCell iso={row.original.enqueued_at} />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "duration",
    header: () => <span className="block text-right">Duration</span>,
    cell: ({ row }) => (
      <span className="block text-right font-mono text-[12px] text-muted-foreground tabular-nums">
        {fmtDuration(row.original.duration)}
      </span>
    ),
  },
]

function JobsPage() {
  const { can } = useMe()
  const [tab, setTab] = useState<"scheduled" | "engines" | "queue">("scheduled")
  const [state, setState] = useState("all")
  const [queue, setQueue] = useState("all")
  const [offset, setOffset] = useState(0)

  const params = new URLSearchParams({
    state,
    queue,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  })

  const q = useQuery({
    queryKey: ["jobs", state, queue, offset],
    queryFn: () => api<JobsResponse>(`/api/jobs/?${params}`),
    placeholderData: keepPreviousData,
    // Live view: poll while the page is open so running/queued counts move.
    refetchInterval: 2500,
    enabled: can("jobs.manage"),
  })

  // The periodic beat (scheduled tasks) + engine/Outpost heartbeats.
  const sched = useQuery({
    queryKey: ["jobs", "scheduled"],
    queryFn: () => api<ScheduledResponse>("/api/jobs/scheduled/"),
    refetchInterval: 5000,
    enabled: can("jobs.manage"),
  })

  if (!can("jobs.manage")) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        You don't have permission to view background jobs.
      </div>
    )
  }

  const data = q.data
  // Indexed access may miss a key at runtime; type it honestly so the `?? 0`
  // fallbacks below are meaningful (Record<string, number> would lie).
  const counts: Record<string, number | undefined> = data?.counts.by_state ?? {}
  const workers = data?.workers ?? []
  const busyWorkers = workers.filter((w) => w.state === "busy").length
  const queued = counts.queued ?? 0
  const total = counts.total ?? 0

  // Only surface deferred/scheduled facets when there's something in them.
  const baseStates = ["queued", "started", "finished", "failed"]
  const extraStates = ["deferred", "scheduled"].filter(
    (s) => (counts[s] ?? 0) > 0
  )
  const statusFacets = [
    { value: "all", label: "All", count: total },
    ...[...baseStates, ...extraStates].map((s) => ({
      value: s,
      label: STATE_META[s]?.label ?? s,
      count: counts[s] ?? 0,
    })),
  ]
  const queues = data?.queues ?? []

  const rows = data?.jobs ?? []
  const filteredTotal = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE))
  const page = Math.floor(offset / PAGE_SIZE) + 1

  const noWorkers = workers.length === 0
  const stalled = noWorkers && queued > 0

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          Jobs
        </h1>
        <SegmentedTabs
          className="ml-2"
          value={tab}
          onValueChange={setTab}
          items={[
            {
              value: "scheduled",
              label: "Scheduled",
              count: sched.data?.tasks.length ?? null,
            },
            {
              value: "engines",
              label: "Engines & Outposts",
              count: sched.data?.engines.length ?? null,
            },
            { value: "queue", label: "Queue", count: total || null },
          ]}
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Cpu className="h-3.5 w-3.5" />
          <span>
            <span
              className={
                workers.length > 0
                  ? "font-medium text-foreground"
                  : "font-medium text-destructive"
              }
            >
              {workers.length}
            </span>{" "}
            worker{workers.length === 1 ? "" : "s"}
            {workers.length > 0 && ` · ${busyWorkers} busy`}
          </span>
        </div>
      </header>

      {tab === "scheduled" && (
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          {sched.isError ? (
            <QueryError error={sched.error} />
          ) : sched.data ? (
            <ScheduledTasksCard tasks={sched.data.tasks} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      )}

      {tab === "engines" && (
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          {sched.isError ? (
            <QueryError error={sched.error} />
          ) : !sched.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sched.data.engines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No monitoring engines configured for this tenant yet.
            </p>
          ) : (
            <EnginesCard engines={sched.data.engines} />
          )}
        </div>
      )}

      {tab === "queue" && (
      <div className="flex min-h-0 flex-1">
        {/* Filter rail — state + queue are single-select and *server-side*
            (query params → paginated API; facet counts come from server
            aggregates, not the visible page). That's why this can't use the
            client-side `useTableFilters`/`FacetGroup` (multi-select over an
            in-memory row set) — only the shared `FilterRail` container chrome
            is reused; the single-select buttons stay bespoke. */}
        <FilterRail>
          <div>
            <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Status
            </h3>
            <ul className="space-y-0.5">
              {statusFacets.map((opt) => {
                const active = state === opt.value
                const variant = STATE_META[opt.value]?.variant
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => {
                        setState(opt.value)
                        setOffset(0)
                      }}
                      className={
                        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/50 " +
                        (active ? "bg-muted font-medium text-foreground" : "")
                      }
                    >
                      <span
                        className={
                          "inline-block h-1.5 w-1.5 shrink-0 rounded-full " +
                          (variant ? STATE_DOT[variant] : "bg-muted-foreground")
                        }
                      />
                      <span className="flex-1 truncate">{opt.label}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                        {opt.count.toLocaleString()}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>

          {queues.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Queue
              </h3>
              <ul className="space-y-0.5">
                {[
                  { value: "all", label: "Any queue" },
                  ...queues.map((qn) => ({ value: qn, label: qn })),
                ].map((opt) => {
                  const active = queue === opt.value
                  return (
                    <li key={opt.value}>
                      <button
                        type="button"
                        onClick={() => {
                          setQueue(opt.value)
                          setOffset(0)
                        }}
                        className={
                          "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/50 " +
                          (active ? "bg-muted font-medium text-foreground" : "")
                        }
                      >
                        <span className="flex-1 truncate font-mono">
                          {opt.label}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </FilterRail>

        {/* Main column — alerts + table + pagination. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-auto p-4 lg:p-6">
          <div className="space-y-3">
            {/* Self-upgrade progress / next auto-update countdown. */}
            {data?.system && <SystemUpgradeCard system={data.system} />}

            {/* No-workers diagnostic — the exact failure mode this page exists for. */}
            {stalled && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <span className="font-medium">No workers are running.</span>{" "}
                  {queued.toLocaleString()} job{queued === 1 ? "" : "s"} are
                  queued and won't be processed until a worker comes online (
                  <code className="font-mono">
                    systemctl --user start danbyte-workers
                  </code>
                  ).
                </div>
              </div>
            )}

            {data?.truncated && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-300">
                Showing the first {data.total.toLocaleString()} jobs — narrow by
                state or queue to see the rest.
              </div>
            )}

            {q.isError && <QueryError error={q.error} />}

            <DataTable
              data={rows}
              columns={columns}
              flexColumn="job"
              stickyHeader
              tableId="jobs"
              enableExport={false}
            />

            {pages > 1 && (
              <div className="flex items-center justify-end gap-2 text-[13px]">
                <button
                  disabled={offset <= 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="text-muted-foreground">
                  {page} / {pages}
                </span>
                <button
                  disabled={page >= pages}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  )
}
