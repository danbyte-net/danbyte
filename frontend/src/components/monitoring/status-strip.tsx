import { useMemo, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, transitionsQuery } from "@/lib/api"
import type {
  AlertsResponse,
  StatusSegment,
  TransitionsResponse,
} from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { detailSummary } from "./check-history"
import { SourceBadge } from "./source-badge"
import { CheckStatusBadge } from "./status-badge"
import { statusColor, useStatusLabels } from "./status-palette"

/** What a segment can be asked about: the object and, for one check's
 * strip, the check - so the popover can list the alerts open while it
 * lasted and the change that started it. */
export interface StripScope {
  ip?: string
  device?: string
  template?: string
}

const SEV_VARIANT = {
  critical: "destructive",
  warning: "warning",
  info: "secondary",
} as const

/** A run of status over a window, to scale: one block per segment, its width
 * the share of the window it covered - one bar per sample would say nothing
 * about *when*, which is the whole point. Hovering a block says what it was
 * and for how long; clicking opens it: the exact bounds, the status change
 * that started it, and the alerts that were open while it lasted. */
export function StatusStrip({
  segments,
  since,
  until,
  height = 8,
  className,
  scope,
}: {
  segments: StatusSegment[]
  since: string
  until: string
  height?: number
  className?: string
  scope?: StripScope
}) {
  const labels = useStatusLabels()
  const { formatDateTime } = useDateFormat()
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [anchorX, setAnchorX] = useState(0)
  const t0 = new Date(since).getTime()
  const t1 = new Date(until).getTime()
  const span = Math.max(1, t1 - t0)

  // Clipped to the window, with each block's share of it.
  const blocks = useMemo(
    () =>
      segments
        .map((s, i) => {
          const a = Math.max(t0, new Date(s.start).getTime())
          const b = Math.min(t1, new Date(s.end).getTime())
          return { i, s, a, b, left: (a - t0) / span, width: (b - a) / span }
        })
        .filter((b) => b.b > b.a),
    [segments, t0, t1, span]
  )

  const at = (clientX: number) => {
    const el = box.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const f = (clientX - r.left) / Math.max(1, r.width)
    const hit = blocks.find((b) => f >= b.left && f < b.left + b.width)
    setAnchorX(clientX - r.left)
    return hit ? hit.i : null
  }
  const current = open ?? hover
  const seg = current == null ? null : blocks.find((b) => b.i === current)

  return (
    <Popover open={open != null} onOpenChange={(o) => !o && setOpen(null)}>
      <Tooltip open={hover != null && open == null}>
        <div
          ref={box}
          className={
            "relative flex w-full cursor-pointer overflow-hidden rounded-[2px] bg-muted " +
            (className ?? "")
          }
          style={{ height }}
          role="img"
          aria-label={`Status over ${fmtSpan(span)}`}
          onMouseMove={(e) => {
            // The click card stays where it was opened.
            if (open == null) setHover(at(e.clientX))
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const i = at(e.clientX)
            setOpen(i)
          }}
        >
          {blocks.map((b) => (
            <div
              key={b.i}
              className="absolute inset-y-0"
              style={{
                left: `${b.left * 100}%`,
                width: `max(1px, ${b.width * 100}%)`,
                background: statusColor(b.s.status, labels),
                opacity:
                  b.s.status === "unknown" || b.s.status === "skipped"
                    ? 0.45
                    : current === b.i
                      ? 0.75
                      : 1,
              }}
            />
          ))}
          {/* One anchor for both the hover card and the click card, parked
              under the pointer - a card per block would be thousands. */}
          <TooltipTrigger asChild>
            <PopoverAnchor asChild>
              <span
                className="pointer-events-none absolute top-0 h-full w-0"
                style={{ left: anchorX }}
              />
            </PopoverAnchor>
          </TooltipTrigger>
        </div>
        {seg && (
          <TooltipContent side="top" className="flex items-center gap-2">
            <CheckStatusBadge status={seg.s.status} />
            <span className="num">{fmtSpan(seg.b - seg.a)}</span>
            <span className="text-muted-foreground">
              {formatDateTime(seg.s.start)} → {formatDateTime(seg.s.end)}
            </span>
          </TooltipContent>
        )}
      </Tooltip>
      {seg && open != null && (
        <PopoverContent side="top" align="center" className="w-96 p-3">
          <SegmentCard segment={seg.s} clippedMs={seg.b - seg.a} scope={scope} />
        </PopoverContent>
      )}
    </Popover>
  )
}

/** The click card: the bounds, the change that opened the segment, and the
 * alerts open while it lasted - fetched only once the card is open. */
function SegmentCard({
  segment,
  clippedMs,
  scope,
}: {
  segment: StatusSegment
  clippedMs: number
  scope?: StripScope
}) {
  const { formatDateTime } = useDateFormat()
  const objectPath = scope?.ip
    ? `ips/${scope.ip}`
    : scope?.device
      ? `devices/${scope.device}`
      : null
  // A second either side: the change that *started* the segment sits on
  // its start stamp, and stamps round.
  const from = new Date(new Date(segment.start).getTime() - 1500).toISOString()
  const to = new Date(new Date(segment.start).getTime() + 1500).toISOString()
  const change = useQuery({
    queryKey: ["strip-change", objectPath, segment.start, scope?.template],
    queryFn: () =>
      api<TransitionsResponse>(
        `/api/monitoring/${objectPath}/transitions/${transitionsQuery({
          since: from,
          until: to,
          template: scope?.template,
          page_size: 5,
        })}`
      ),
    enabled: objectPath != null,
    staleTime: 60_000,
  })
  const alerts = useQuery({
    queryKey: ["strip-alerts", scope?.ip, scope?.device, scope?.template, segment.start, segment.end],
    queryFn: () => {
      const p = new URLSearchParams({
        status: "all",
        since: segment.start,
        until: segment.end,
      })
      if (scope?.ip) p.set("ip", scope.ip)
      if (scope?.device) p.set("device", scope.device)
      if (scope?.template) p.set("template", scope.template)
      return api<AlertsResponse>(`/api/monitoring/alerts/?${p.toString()}`)
    },
    enabled: !!(scope?.ip || scope?.device),
    staleTime: 60_000,
  })
  const opened = change.data?.results.find((r) => r.to_status === segment.status)
  const rows = alerts.data?.results ?? []

  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex items-center gap-2">
        <CheckStatusBadge status={segment.status} />
        <span className="num font-medium">{fmtSpan(clippedMs)}</span>
        {clippedMs < new Date(segment.end).getTime() - new Date(segment.start).getTime() && (
          <span className="text-xs text-muted-foreground">in this window</span>
        )}
      </div>
      <dl className="grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">From</dt>
        <dd className="num">{formatDateTime(segment.start)}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="num">{formatDateTime(segment.end)}</dd>
      </dl>
      {opened && (
        <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
          <div className="flex items-center gap-1.5">
            <CheckStatusBadge status={opened.from_status} />
            <span className="text-muted-foreground">→</span>
            <CheckStatusBadge status={opened.to_status} />
            {opened.template && (
              <span className="truncate text-muted-foreground">
                {opened.template.name}
              </span>
            )}
            <span className="ml-auto">
              <SourceBadge source={opened.source} engine={opened.engine} />
            </span>
          </div>
          <div className="mt-1 truncate text-muted-foreground">
            {detailSummary(opened.detail)}
          </div>
        </div>
      )}
      {(scope?.ip || scope?.device) && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Alerts
          </div>
          {alerts.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              None open during this.
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {rows.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center gap-2 py-1 text-xs">
                  <Badge variant={SEV_VARIANT[a.severity]}>{a.severity}</Badge>
                  <span className="truncate">
                    {a.rule_name ?? a.template?.name ?? a.kind}
                  </span>
                  <span className="num ml-auto shrink-0 text-muted-foreground">
                    {formatDateTime(a.opened_at)}
                    {a.resolved_at ? ` → ${formatDateTime(a.resolved_at)}` : " · firing"}
                  </span>
                </li>
              ))}
              {rows.length > 8 && (
                <li className="py-1 text-xs text-muted-foreground">
                  + {rows.length - 8} more
                </li>
              )}
            </ul>
          )}
          <div className="mt-1 text-right">
            <Link
              to="/alerts"
              search={{
                tab: "alerts",
                state: "resolved",
                severity: "all",
                ack: "all",
                q: "",
                site: "all",
                kind: "",
              }}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              All alerts
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

/** A duration in the largest unit that still reads whole-ish. */
export function fmtSpan(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${(h / 24).toFixed(1)}d`
}
