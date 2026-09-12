import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api, transitionsQuery } from "@/lib/api"
import type {
  DeviceTimeline,
  IpTimeline,
  StatusSegment,
  TransitionsResponse,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { transitionColumns } from "@/components/columns/transition-columns"
import { Section } from "@/components/ui/section"
import { DailyAvailability } from "./daily-availability"
import { StatusStrip, fmtSpan } from "./status-strip"

export const HISTORY_WINDOWS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const

export type HistoryScope =
  | { ip: string }
  | { device: string }
  | { prefix: string }

function scopePath(scope: HistoryScope): string {
  if ("ip" in scope) return `ips/${scope.ip}`
  if ("device" in scope) return `devices/${scope.device}`
  return `prefixes/${scope.prefix}`
}

const PAGE = 25

/**
 * What has happened to one target: its status over a window drawn to scale,
 * then the changes behind the picture, paged. The strip and the rows come
 * from the same transitions, so what a segment says and what the table lists
 * cannot disagree. Mounted under the check rows on an address's Monitoring
 * tab, and on a device's; a prefix gets the table only, its addresses' strips
 * being its own Monitoring tab's job.
 */
export function HistoryPanel({ scope }: { scope: HistoryScope }) {
  const [days, setDays] = useState<number>(7)
  const [page, setPage] = useState(1)
  const path = scopePath(scope)
  const hasStrips = !("prefix" in scope)

  const timeline = useQuery({
    queryKey: ["monitoring-timeline", path, days],
    queryFn: () =>
      api<IpTimeline | DeviceTimeline>(
        `/api/monitoring/${path}/timeline/?days=${days}`
      ),
    enabled: hasStrips,
  })
  const changes = useQuery({
    queryKey: ["monitoring-transitions", path, days, page],
    queryFn: () =>
      api<TransitionsResponse>(
        `/api/monitoring/${path}/transitions/${transitionsQuery({
          days,
          page,
          page_size: PAGE,
        })}`
      ),
    placeholderData: keepPreviousData,
  })

  const tl = timeline.data
  const rows = changes.data?.results ?? []
  const total = changes.data?.count ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const columns = transitionColumns(
    "ip" in scope ? ["target", "device", "site"] : ["site", "device"]
  )
  const historySearch = {
    view: "history" as const,
    status: "all" as const,
    days: String(days),
    ...("ip" in scope
      ? { ip: scope.ip }
      : "device" in scope
        ? { device: scope.device }
        : { prefix: scope.prefix }),
  }

  const measuredDays = tl
    ? tl.days.filter((d) => d.uptime_pct != null).length
    : 0
  const summary = tl?.summary

  return (
    <Section
      title="History"
      actions={
        <>
          <Link
            to="/monitoring"
            search={historySearch}
            className="link text-xs"
          >
            Open in Monitoring
          </Link>
          <SegmentedTabs
            value={String(days)}
            onValueChange={(v) => {
              setDays(Number(v))
              setPage(1)
            }}
            items={HISTORY_WINDOWS.map((w) => ({
              value: String(w.days),
              label: w.label,
            }))}
          />
        </>
      }
    >
      <div className="space-y-4">
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {/* The window's figures - what the SLA card used to say on its own,
            now beside the picture they describe and on the same window. */}
          {hasStrips && summary && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2.5">
              <span
                className={`num text-2xl font-semibold tracking-tight ${tier(summary.uptime_pct)}`}
              >
                {fmtPct(summary.uptime_pct)}
              </span>
              <span className="text-xs text-muted-foreground">
                availability · {summary.incidents} incident
                {summary.incidents === 1 ? "" : "s"}
                {summary.mttr_seconds != null &&
                  ` · MTTR ${fmtSpan(summary.mttr_seconds * 1000)}`}
                {summary.down_seconds > 0 &&
                  ` · ${fmtSpan(summary.down_seconds * 1000)} down`}
              </span>
            </div>
          )}
          {hasStrips && tl && measuredDays >= 3 && (
            <div className="px-3 py-2.5">
              <DailyAvailability days={tl.days} />
            </div>
          )}
          {hasStrips && tl && (
            <div className="space-y-1.5 px-3 py-2.5">
              <StripRow
                label="All checks"
                segments={tl.rollup}
                since={tl.since}
                until={tl.until}
                uptime={summary?.uptime_pct}
                strong
              />
              {"ips" in tl &&
                tl.ips.length > 1 &&
                tl.ips.map((ip) => (
                  <StripRow
                    key={ip.id}
                    label={
                      <Link
                        to="/ips/$id"
                        params={{ id: ip.id }}
                        search={{ tab: "monitoring" }}
                        className="link font-mono"
                      >
                        {ip.ip_address}
                      </Link>
                    }
                    segments={ip.rollup}
                    since={tl.since}
                    until={tl.until}
                    uptime={ip.uptime_pct}
                  />
                ))}
              {"ip" in scope &&
                tl.checks.length > 1 &&
                tl.checks.map((c) => (
                  <StripRow
                    key={c.state_id}
                    label={
                      <>
                        {c.template_name ?? c.kind}{" "}
                        <span className="font-mono text-[10px] uppercase">
                          {c.kind}
                        </span>
                      </>
                    }
                    segments={c.segments}
                    since={tl.since}
                    until={tl.until}
                    uptime={c.uptime_pct}
                  />
                ))}
            </div>
          )}
        </div>
        {/* Its own frame, as a sibling: the table draws a border of its own,
          and a box inside a box was half of what looked nested. */}
        {changes.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            embedded
            enableExport={false}
            flexColumn="detail"
            serverPagination={{
              page,
              pageCount: pages,
              totalRows: total,
              onPageChange: setPage,
            }}
          />
        )}
      </div>
    </Section>
  )
}

function fmtPct(p: number | null | undefined): string {
  return p == null ? "-" : `${p.toFixed(p >= 99.95 ? 2 : 1)}%`
}

// The same tiers as the daily bars: three nines, two nines, less.
function tier(p: number | null | undefined): string {
  if (p == null) return "text-muted-foreground"
  if (p >= 99.9) return "text-emerald-600 dark:text-emerald-400"
  if (p >= 99) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

function StripRow({
  label,
  segments,
  since,
  until,
  uptime,
  strong,
}: {
  label: React.ReactNode
  segments: StatusSegment[]
  since: string
  until: string
  /** The window's availability for this run, at the strip's end. */
  uptime?: number | null
  strong?: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-[12px]">
      <span
        className={
          "w-40 shrink-0 truncate " +
          (strong ? "font-medium" : "text-muted-foreground")
        }
      >
        {label}
      </span>
      <StatusStrip
        segments={segments}
        since={since}
        until={until}
        height={strong ? 10 : 8}
      />
      <span
        className={`num w-16 shrink-0 text-right text-[11px] ${tier(uptime)}`}
      >
        {fmtPct(uptime)}
      </span>
    </div>
  )
}
