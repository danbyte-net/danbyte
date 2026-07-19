import type { SparkPoint } from "@/lib/api"

// A tiny status/latency sparkline: one bar per recent result. Bar colour shows
// the status (green up / red down / amber degraded / zinc unknown); bar height
// shows latency relative to the window's max. No axes, no library — it sits
// inline in a dense row.
const COLOR: Record<string, string> = {
  up: "var(--color-emerald-500)",
  down: "var(--color-red-500)",
  degraded: "var(--color-amber-500)",
  unknown: "var(--color-zinc-400)",
  stale: "var(--color-zinc-400)",
}

export function Sparkline({
  points,
  width = 120,
  height = 22,
}: {
  points: SparkPoint[]
  width?: number
  height?: number
}) {
  if (points.length === 0) {
    return (
      <span className="text-[11px] text-muted-foreground">no history yet</span>
    )
  }
  const lat = points.map((p) => p.latency_ms ?? 0)
  const max = Math.max(1, ...lat)
  const n = points.length
  const gap = 1
  const barW = Math.max(1, (width - (n - 1) * gap) / n)

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      role="img"
      aria-label={`${n} recent checks`}
    >
      {points.map((p, i) => {
        const reachable = p.status === "up" || p.status === "degraded"
        // Down/unknown get a short stub so the outage is still visible.
        const h = reachable
          ? Math.max(2, ((p.latency_ms ?? 0) / max) * (height - 2))
          : height - 2
        const x = i * (barW + gap)
        return (
          <rect
            key={i}
            x={x}
            y={height - h}
            width={barW}
            height={h}
            rx={0.5}
            fill={COLOR[p.status] ?? COLOR.unknown}
            opacity={reachable ? 0.9 : 0.45}
          >
            <title>
              {new Date(p.timestamp).toLocaleString()} · {p.status}
              {p.latency_ms != null ? ` · ${p.latency_ms.toFixed(1)} ms` : ""}
            </title>
          </rect>
        )
      })}
    </svg>
  )
}
