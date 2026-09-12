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
import { StatusStrip } from "./status-strip"
import { SourceBadge } from "./source-badge"

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

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          History
        </h3>
        <SegmentedTabs
          className="ml-auto"
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
      </div>

      {hasStrips && tl && (
        <div className="space-y-1.5 border-t border-border px-3 py-2.5">
          <StripRow
            label="All checks"
            segments={tl.rollup}
            since={tl.since}
            until={tl.until}
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
              />
            ))}
          {"ip" in scope &&
            tl.checks.length > 1 &&
            tl.checks.map((c) => (
              <StripRow
                key={c.state_id}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    {c.template_name ?? c.kind}
                    <SourceBadge source={c.source} />
                  </span>
                }
                segments={c.segments}
                since={tl.since}
                until={tl.until}
              />
            ))}
        </div>
      )}

      <div className="border-t border-border">
        {changes.isLoading ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            No status changes in this window.
          </p>
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
      <div className="border-t border-border px-3 py-1.5 text-right">
        <Link
          to="/monitoring"
          search={historySearch}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Open in Monitoring → History
        </Link>
      </div>
    </section>
  )
}

function StripRow({
  label,
  segments,
  since,
  until,
  strong,
}: {
  label: React.ReactNode
  segments: StatusSegment[]
  since: string
  until: string
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
    </div>
  )
}
