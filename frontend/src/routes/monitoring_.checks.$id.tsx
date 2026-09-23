import { createFileRoute, Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { api, transitionsQuery } from "@/lib/api"
import type { CheckDetail, TransitionsResponse } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash, mono } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { DataTable } from "@/components/data-table"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Section } from "@/components/ui/section"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { transitionColumns } from "@/components/columns/transition-columns"
import {
  availabilityTone,
  fmtMs,
  fmtPct,
} from "@/components/monitoring/availability"
import { CheckHistory } from "@/components/monitoring/check-history"
import { FlappingPill } from "@/components/monitoring/flapping-pill"
import { LatencyChart } from "@/components/monitoring/latency-chart"
import {
  RollupAvailabilityChart,
  RollupLatencyChart,
} from "@/components/monitoring/rollup-charts"
import { SourceBadge } from "@/components/monitoring/source-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { fmtSpan } from "@/components/monitoring/status-strip"

export const Route = createFileRoute("/monitoring_/checks/$id")({
  component: CheckPage,
})

// The window the figures and rollup charts cover. Hours read hourly rows,
// days read daily rows plus today so far.
const WINDOWS = [
  { value: "h24", label: "24h", query: "hours=24" },
  { value: "d7", label: "7d", query: "days=7" },
  { value: "d30", label: "30d", query: "days=30" },
  { value: "d90", label: "90d", query: "days=90" },
  { value: "d365", label: "1y", query: "days=365" },
] as const
type WindowKey = (typeof WINDOWS)[number]["value"]

function CheckPage() {
  const { id } = Route.useParams()
  const [win, setWin] = useState<WindowKey>("d30")
  const query = WINDOWS.find((w) => w.value === win)!.query
  const q = useQuery({
    queryKey: ["monitoring-check", id, query],
    queryFn: () => api<CheckDetail>(`/api/monitoring/checks/${id}/?${query}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading...</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body check={q.data} win={win} onWin={setWin} />
}

function Body({
  check: c,
  win,
  onWin,
}: {
  check: CheckDetail
  win: WindowKey
  onWin: (w: WindowKey) => void
}) {
  const [tab, setTab] = useUrlTab<"overview" | "changes" | "results">(
    "overview"
  )
  const f = c.figures
  const windowTabs = (
    <SegmentedTabs
      value={win}
      onValueChange={(v) => onWin(v)}
      items={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
    />
  )
  return (
    <DetailShell
      backTo="/monitoring"
      backSearch={{ view: "checks", status: "all" }}
      backLabel="Checks"
      title={
        <span>
          <span className="font-mono">{c.target_ip.ip_address}</span> ·{" "}
          {c.template.name}
        </span>
      }
      hero={
        <DetailHero
          title={c.template.name}
          badges={
            <>
              <CheckStatusBadge status={c.status} />
              {c.flapping_since && <FlappingPill count={c.flap_count} />}
            </>
          }
          subtitle={
            <>
              <Link
                to="/ips/$id"
                params={{ id: c.target_ip.id }}
                search={{ tab: "monitoring" }}
                className="link font-mono"
              >
                {c.target_ip.ip_address}
              </Link>
              {c.device && (
                <Link
                  to="/devices/$id"
                  params={{ id: c.device.id }}
                  search={{ tab: "monitoring" }}
                  className="link"
                >
                  {c.device.name}
                </Link>
              )}
              <span className="font-mono text-[11px] uppercase">{c.kind}</span>
            </>
          }
          statCols={3}
          stats={
            <>
              <DetailStat
                label="Availability"
                value={
                  <span
                    className={`num font-medium ${availabilityTone(f.availability)}`}
                  >
                    {fmtPct(f.availability)}
                  </span>
                }
              />
              <DetailStat
                label="p95"
                value={<span className="num">{fmtMs(f.p95)}</span>}
              />
              <DetailStat
                label="Baseline"
                value={<span className="num">{fmtMs(c.baseline_ms)}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "changes", label: "Status changes" },
        { value: "results", label: "Results" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <KvCard
              title="Check"
              rows={[
                {
                  label: "Status",
                  value: <CheckStatusBadge status={c.status} />,
                },
                {
                  label: "Since",
                  value: c.since ? <TimeCell iso={c.since} /> : dash,
                },
                {
                  label: "Last checked",
                  value: c.last_checked ? (
                    <TimeCell iso={c.last_checked} />
                  ) : (
                    dash
                  ),
                },
                { label: "Last latency", value: fmtMs(c.last_latency_ms) },
                {
                  label: "Runs on",
                  value: <SourceBadge source={c.source} engine={c.engine} />,
                },
                {
                  label: "Site",
                  value: c.site ? (
                    <Link
                      to="/sites/$id"
                      params={{ id: c.site.id }}
                      className="link"
                    >
                      {c.site.name}
                    </Link>
                  ) : (
                    dash
                  ),
                },
                {
                  label: "Prefix",
                  value: c.prefix ? (
                    <Link
                      to="/prefixes/$id"
                      params={{ id: c.prefix.id }}
                      className="link"
                    >
                      {mono(c.prefix.cidr)}
                    </Link>
                  ) : (
                    dash
                  ),
                },
              ]}
            />
            <KvCard
              title="Window"
              rows={[
                {
                  label: "Availability",
                  value: (
                    <span className={`num ${availabilityTone(f.availability)}`}>
                      {fmtPct(f.availability)}
                    </span>
                  ),
                },
                {
                  label: "Coverage",
                  value: f.coverage == null ? dash : `${f.coverage}%`,
                },
                {
                  label: "Incidents",
                  value: <span className="num">{f.incidents}</span>,
                },
                {
                  label: "Time to recover",
                  value: f.mttr_s == null ? dash : fmtSpan(f.mttr_s * 1000),
                },
                {
                  label: "Latency p50 / p95 / p99",
                  value: (
                    <span className="num">
                      {fmtMs(f.p50)} / {fmtMs(f.p95)} / {fmtMs(f.p99)}
                    </span>
                  ),
                },
                {
                  label: "Spike threshold",
                  value: fmtMs(c.spike_threshold_ms),
                },
                {
                  label: "Spikes",
                  value: <span className="num">{f.spikes}</span>,
                },
              ]}
            />
          </div>
          <Section title="Availability" actions={windowTabs}>
            <RollupAvailabilityChart series={c.series} daily={c.window.daily} />
          </Section>
          <Section title="Latency against baseline">
            <RollupLatencyChart
              series={c.series}
              daily={c.window.daily}
              baseline={c.baseline_ms}
              threshold={c.spike_threshold_ms}
            />
          </Section>
          <Section title="Probes">
            <LatencyChart ipId={c.target_ip.id} templateId={c.template.id} />
          </Section>
        </div>
      </DetailTab>
      <DetailTab value="changes">
        <Changes check={c} />
      </DetailTab>
      <DetailTab value="results">
        <CheckHistory ipId={c.target_ip.id} templateId={c.template.id} />
      </DetailTab>
    </DetailShell>
  )
}

const PAGE = 25

function Changes({ check: c }: { check: CheckDetail }) {
  const [page, setPage] = useState(1)
  const q = useQuery({
    queryKey: ["monitoring-check-transitions", c.id, page],
    queryFn: () =>
      api<TransitionsResponse>(
        `/api/monitoring/transitions/${transitionsQuery({
          ip: c.target_ip.id,
          template: c.template.id,
          days: 365,
          page,
          page_size: PAGE,
        })}`
      ),
    placeholderData: keepPreviousData,
  })
  if (q.isError) return <QueryError error={q.error} />
  const total = q.data?.count ?? 0
  return (
    <DataTable
      columns={transitionColumns(["target", "device", "site", "check"])}
      data={q.data?.results ?? []}
      embedded
      enableExport={false}
      flexColumn="detail"
      serverPagination={{
        page,
        pageCount: Math.max(1, Math.ceil(total / PAGE)),
        totalRows: total,
        onPageChange: setPage,
      }}
    />
  )
}
