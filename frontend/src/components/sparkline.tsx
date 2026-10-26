import { cn } from "@/lib/utils"

/**
 * A small line of recent values, scaled to its own min and max - the glance,
 * not the graph you read (that is a `ChartContainer` chart). Gaps (null) break
 * the line. Drawn in `currentColor`, so the caller says what it means; muted
 * by default.
 */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  className,
  label,
}: {
  values: (number | null)[]
  width?: number
  height?: number
  className?: string
  /** What the line shows, for assistive tech. */
  label?: string
}) {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length < 2)
    return (
      <span
        className={cn("inline-block", className)}
        style={{ width, height }}
        aria-hidden="true"
      />
    )
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const span = hi - lo || 1
  const pad = 1.5
  const step = values.length > 1 ? width / (values.length - 1) : width
  // One polyline per run of values, so a gap reads as a gap.
  const runs: string[][] = [[]]
  values.forEach((v, i) => {
    if (v == null) {
      if (runs[runs.length - 1].length) runs.push([])
      return
    }
    const x = i * step
    const y = pad + (1 - (v - lo) / span) * (height - 2 * pad)
    runs[runs.length - 1].push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("text-muted-foreground", className)}
      role="img"
      aria-label={label}
    >
      {runs
        .filter((r) => r.length > 1)
        .map((r, i) => (
          <polyline
            key={i}
            points={r.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinejoin="round"
          />
        ))}
    </svg>
  )
}
