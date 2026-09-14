import { useEffect, useMemo, useState } from "react"
import { useSearch } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { api, transitionsQuery } from "@/lib/api"
import type {
  CheckStatus,
  TransitionFilters,
  TransitionRow,
  TransitionsResponse,
} from "@/lib/api"
import { useUrlPatch } from "@/lib/use-url-state"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DatePicker } from "@/components/ui/date-picker"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  countAxisWidth,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import type { FilterSnapshot } from "@/components/table-filters"
import { transitionColumns } from "@/components/columns/transition-columns"
import { HistoryHeatmap } from "./history-heatmap"
import { TopChanges } from "./top-changes"
import { MonitoringRail, RAIL_KEYS, railActiveCount } from "./monitoring-rail"
import type { RailFilters } from "./monitoring-rail"
import { statusColor, statusLabel, useStatusLabels } from "./status-palette"

const WINDOWS = ["1", "7", "30", "90"] as const
const PAGE = 50
const SERIES_ORDER: CheckStatus[] = [
  "down",
  "degraded",
  "stale",
  "up",
  "skipped",
  "unknown",
]

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined

/** A `YYYY-MM-DD` day to the aware stamp the server insists on: the start of
 * that day for `since`, the end of it for `until`, in the browser's zone. */
function dayToIso(day: string, end: boolean): string {
  const [y, m, d] = day.split("-").map(Number)
  const at = end ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d)
  return at.toISOString()
}
const isoToDay = (iso: string | undefined): string => {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * `/monitoring?view=history` - every status change in the tenant, filtered by
 * anything an address is, with a chart of how many landed per hour or day.
 * The URL is the state: the rail, the window, the search and the page all
 * live in it, so a view is a link and a saved view is a snapshot of one.
 */
export function HistoryView() {
  const search = useSearch({ strict: false })
  const patch = useUrlPatch()
  const labels = useStatusLabels()

  const rail: RailFilters = Object.fromEntries(
    RAIL_KEYS.map((k) => [k, str(search[k])])
  )
  const ip = str(search.ip)
  const dow = str(search.dow)
  const hour = str(search.hour)
  const cell =
    dow !== undefined && hour !== undefined
      ? { dow: Number(dow), hour: Number(hour) }
      : null
  const since = str(search.since)
  const until = str(search.until)
  const custom = !!(since || until)
  const days = str(search.days) ?? "7"
  const q = str(search.q) ?? ""
  const page = Number(str(search.page) ?? "1") || 1
  const ordering = (str(search.ordering) ??
    "-at") as TransitionFilters["ordering"]

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(
      () =>
        patch({ q: draft || undefined, page: undefined }, { replace: true }),
      300
    )
    return () => clearTimeout(t)
  }, [draft])

  const filters: TransitionFilters = {
    ...rail,
    ip,
    dow,
    hour,
    search: q || undefined,
    ordering,
    page,
    page_size: PAGE,
    ...(custom ? { since, until } : { days: Number(days) }),
  }
  const query = useQuery({
    queryKey: ["monitoring-transitions", "all", filters],
    queryFn: () =>
      api<TransitionsResponse>(
        `/api/monitoring/transitions/${transitionsQuery(filters)}`
      ),
    placeholderData: keepPreviousData,
  })
  const data = query.data
  const rows = data?.results ?? []
  const total = data?.count ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  const seriesConfig = useMemo(
    () =>
      Object.fromEntries(
        SERIES_ORDER.map((s) => [
          s,
          { label: statusLabel(s, labels), color: statusColor(s, labels) },
        ])
      ) satisfies ChartConfig,
    [labels]
  )
  const seriesData = (data?.series ?? []).map((p) => ({
    ...p,
    label:
      data?.bucket === "day"
        ? new Date(p.t).toLocaleDateString([], {
            month: "short",
            day: "numeric",
          })
        : new Date(p.t).toLocaleString([], {
            weekday: "short",
            hour: "2-digit",
          }),
  }))
  const present = SERIES_ORDER.filter((s) =>
    (data?.series ?? []).some((p) => (p[s] ?? 0) > 0)
  )

  // Saved views hold the rail, the window and the search - the URL keys, as
  // they are, so restoring one is one patch.
  const snapshot = (): FilterSnapshot => {
    const out: FilterSnapshot = {}
    for (const k of RAIL_KEYS) if (rail[k]) out[k] = rail[k]!
    if (ip) out.ip = ip
    if (dow !== undefined) out.dow = dow
    if (hour !== undefined) out.hour = hour
    if (custom) {
      if (since) out.since = since
      if (until) out.until = until
    } else if (days !== "7") out.days = days
    return out
  }
  const restore = (snap: FilterSnapshot | null | undefined) => {
    const next: Record<string, string | undefined> = { page: undefined }
    for (const k of [
      ...RAIL_KEYS,
      "ip",
      "since",
      "until",
      "days",
      "dow",
      "hour",
    ])
      next[k] = undefined
    for (const [k, v] of Object.entries(snap ?? {}))
      if (typeof v === "string") next[k] = v
      else if (Array.isArray(v)) next[k] = v.join(",")
    patch(next)
  }

  const columns = useMemo(() => transitionColumns(), [])

  return (
    <ListPageShell
      title="History"
      count={data ? total : undefined}
      rail={
        <MonitoringRail
          facets={data?.facets ?? {}}
          filters={rail}
          onChange={(p) => patch(p)}
          showFrom
          showFlapping
        />
      }
      search={{
        value: draft,
        onChange: setDraft,
        placeholder: "Address, DNS name, device, check…",
      }}
      savedViews={{
        objectType: "monitoring-history",
        filters: {
          snapshot,
          restore,
          activeCount: railActiveCount(rail) + (ip ? 1 : 0),
        },
      }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs
            value={custom ? "custom" : days}
            onValueChange={(v) => {
              if (v === "custom") {
                const now = new Date()
                const from = new Date(now.getTime() - 7 * 86400_000)
                patch({
                  since: dayToIso(isoToDay(from.toISOString()), false),
                  until: undefined,
                  days: undefined,
                  page: undefined,
                })
              } else {
                patch({
                  days: v === "7" ? undefined : v,
                  since: undefined,
                  until: undefined,
                  page: undefined,
                })
              }
            }}
            items={[
              ...WINDOWS.map((w) => ({
                value: w,
                label: w === "1" ? "24h" : `${w}d`,
              })),
              { value: "custom", label: "Custom" },
            ]}
          />
          {custom && (
            <>
              <DatePicker
                value={isoToDay(since)}
                onChange={(d) =>
                  patch({
                    since: d ? dayToIso(d, false) : undefined,
                    page: undefined,
                  })
                }
                placeholder="From"
                className="h-8 text-xs"
              />
              <DatePicker
                value={isoToDay(until)}
                onChange={(d) =>
                  patch({
                    until: d ? dayToIso(d, true) : undefined,
                    page: undefined,
                  })
                }
                placeholder="Until now"
                className="h-8 text-xs"
              />
            </>
          )}
        </div>
      }
      query={query}
    >
      {data && seriesData.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-card p-3">
          <ChartContainer
            config={seriesConfig}
            className="aspect-auto h-[160px] w-full"
          >
            <BarChart
              accessibilityLayer
              data={seriesData}
              margin={{ left: 0, right: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                minTickGap={28}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={countAxisWidth(
                  seriesData.map((p) =>
                    present.reduce((n, s) => n + (Number(p[s]) || 0), 0)
                  )
                )}
                allowDecimals={false}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {present.map((s) => (
                <Bar
                  key={s}
                  dataKey={s}
                  stackId="a"
                  fill={`var(--color-${s})`}
                  radius={0}
                />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        </div>
      )}
      {data && (data.heatmap.length > 0 || data.top.length > 0) && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-3">
            <HistoryHeatmap
              cells={data.heatmap}
              selected={cell}
              onSelect={(c) =>
                patch({
                  dow: c ? String(c.dow) : undefined,
                  hour: c ? String(c.hour) : undefined,
                  page: undefined,
                })
              }
            />
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <TopChanges rows={data.top} />
          </div>
        </div>
      )}
      <DataTable<TransitionRow>
        columns={columns}
        data={rows}
        tableId="monitoring-history"
        exportName="monitoring-history"
        exportTitle="Monitoring history"
        flexColumn="detail"
        exportAll={async () => {
          // The server hands out 200 a page; walk them, capped at 5,000 rows
          // so a year of a busy estate cannot be asked for by accident.
          const out: TransitionRow[] = []
          for (let p = 1; p <= 25; p++) {
            const r = await api<TransitionsResponse>(
              `/api/monitoring/transitions/${transitionsQuery({
                ...filters,
                page: p,
                page_size: 200,
              })}`
            )
            out.push(...r.results)
            if (out.length >= r.count) break
          }
          return out
        }}
        serverPagination={{
          page,
          pageCount: pages,
          totalRows: total,
          onPageChange: (p) => patch({ page: p === 1 ? undefined : String(p) }),
        }}
      />
    </ListPageShell>
  )
}
