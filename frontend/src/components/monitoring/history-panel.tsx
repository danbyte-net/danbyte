import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { SlidersHorizontal } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Section } from "@/components/ui/section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { DailyAvailability } from "./daily-availability"
import { StatusStrip, fmtSpan } from "./status-strip"
import type { StripScope } from "./status-strip"

/** The windows on the tabs, in hours. */
export const HISTORY_WINDOWS = [
  { hours: 1, label: "1h" },
  { hours: 12, label: "12h" },
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
  { hours: 2160, label: "90d" },
] as const

/** The slider's stops - an hour to ninety days, denser where an operator
 * actually looks. */
const STOPS = [1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720, 1440, 2160]
const MAX_HOURS = 365 * 24

export function fmtHours(h: number): string {
  if (h >= 24 && h % 24 === 0) return `${h / 24}d`
  return `${h}h`
}

/** Any window at all: a slider over the stops, or a number with its unit. */
function CustomWindow({
  hours,
  onChange,
}: {
  hours: number
  onChange: (hours: number) => void
}) {
  const preset = HISTORY_WINDOWS.some((w) => w.hours === hours)
  const inDays = hours >= 24 && hours % 24 === 0
  const [unit, setUnit] = useState<"h" | "d">(inDays ? "d" : "h")
  const [text, setText] = useState(String(inDays ? hours / 24 : hours))
  const apply = (raw: string, u: "h" | "d") => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return
    onChange(Math.min(MAX_HOURS, Math.round(u === "d" ? n * 24 : n)))
  }
  // Nearest stop for the thumb - the slider is a coarse hand, the input the fine one.
  const idx = STOPS.reduce(
    (best, v, i) =>
      Math.abs(v - hours) < Math.abs(STOPS[best] - hours) ? i : best,
    0
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={preset ? "outline" : "secondary"}
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {preset ? "Custom" : fmtHours(hours)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3">
        <Slider
          min={0}
          max={STOPS.length - 1}
          step={1}
          value={[idx]}
          onValueChange={(v) => {
            const h = STOPS[v[0]]
            const d = h >= 24 && h % 24 === 0
            setUnit(d ? "d" : "h")
            setText(String(d ? h / 24 : h))
            onChange(h)
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            className="h-8 w-24 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => apply(text, unit)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply(text, unit)
            }}
          />
          <Select
            value={unit}
            onValueChange={(u) => {
              setUnit(u as "h" | "d")
              apply(text, u as "h" | "d")
            }}
          >
            <SelectTrigger className="h-8 w-24 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="h">hours</SelectItem>
              <SelectItem value="d">days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  )
}

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
  const [hours, setHours] = useState<number>(168)
  const [page, setPage] = useState(1)
  const path = scopePath(scope)
  const hasStrips = !("prefix" in scope)

  const timeline = useQuery({
    queryKey: ["monitoring-timeline", path, hours],
    queryFn: () =>
      api<IpTimeline | DeviceTimeline>(
        `/api/monitoring/${path}/timeline/?hours=${hours}`
      ),
    enabled: hasStrips,
  })
  const changes = useQuery({
    queryKey: ["monitoring-transitions", path, hours, page],
    queryFn: () =>
      api<TransitionsResponse>(
        `/api/monitoring/${path}/transitions/${transitionsQuery({
          hours,
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
    days: String(Math.max(1, Math.ceil(hours / 24))),
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
            value={String(hours)}
            onValueChange={(v) => {
              setHours(Number(v))
              setPage(1)
            }}
            items={HISTORY_WINDOWS.map((w) => ({
              value: String(w.hours),
              label: w.label,
            }))}
          />
          <CustomWindow
            hours={hours}
            onChange={(h) => {
              setHours(h)
              setPage(1)
            }}
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
                scope={"ip" in scope ? { ip: scope.ip } : "device" in scope ? { device: scope.device } : undefined}
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
                    scope={{ ip: ip.id }}
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
                    scope={{ ip: c.target_ip.id, template: c.template_id }}
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
  scope,
}: {
  label: React.ReactNode
  segments: StatusSegment[]
  since: string
  until: string
  /** The window's availability for this run, at the strip's end. */
  uptime?: number | null
  strong?: boolean
  scope?: StripScope
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
        scope={scope}
      />
      <span
        className={`num w-16 shrink-0 text-right text-[11px] ${tier(uptime)}`}
      >
        {fmtPct(uptime)}
      </span>
    </div>
  )
}
