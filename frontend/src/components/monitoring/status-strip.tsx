import type { StatusSegment } from "@/lib/api"
import { statusColor, statusLabel, useStatusLabels } from "./status-palette"
import { useDateFormat } from "@/lib/datetime"

/** A run of status over a window, to scale: one rect per segment, its width
 * the share of the window it covered. `Sparkline` stays for latency - one bar
 * per sample tells you nothing about *when*, which is the whole point here.
 * Hover a segment for its status, bounds and length. */
export function StatusStrip({
  segments,
  since,
  until,
  height = 8,
  className,
}: {
  segments: StatusSegment[]
  since: string
  until: string
  height?: number
  className?: string
}) {
  const labels = useStatusLabels()
  const { formatDateTime } = useDateFormat()
  const t0 = new Date(since).getTime()
  const t1 = new Date(until).getTime()
  const span = Math.max(1, t1 - t0)
  const W = 1000
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      height={height}
      className={
        "block w-full overflow-hidden rounded-[2px] " + (className ?? "")
      }
      role="img"
      aria-label={`Status over ${fmtSpan(span)}`}
    >
      <rect x={0} y={0} width={W} height={height} fill="var(--color-muted)" />
      {segments.map((s, i) => {
        const a = Math.max(t0, new Date(s.start).getTime())
        const b = Math.min(t1, new Date(s.end).getTime())
        if (b <= a) return null
        const x = ((a - t0) / span) * W
        const w = Math.max(1, ((b - a) / span) * W)
        return (
          <rect
            key={i}
            x={x}
            y={0}
            width={w}
            height={height}
            fill={statusColor(s.status, labels)}
            opacity={
              s.status === "unknown" || s.status === "skipped" ? 0.45 : 1
            }
          >
            <title>
              {statusLabel(s.status, labels)} · {formatDateTime(s.start)} →{" "}
              {formatDateTime(s.end)} · {fmtSpan(b - a)}
            </title>
          </rect>
        )
      })}
    </svg>
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
