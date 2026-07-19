import type { CheckStatus } from "@/lib/api"

// Shared status → token colour, used by both the badge palette and the charts.
export const STATUS_COLOR: Record<CheckStatus, string> = {
  up: "var(--color-emerald-500)",
  degraded: "var(--color-amber-500)",
  down: "var(--color-red-500)",
  stale: "var(--color-red-800)",
  unknown: "var(--color-zinc-400)",
  skipped: "var(--color-zinc-300)",
}

export const STATUS_LABEL: Record<CheckStatus, string> = {
  up: "Up",
  down: "Down",
  degraded: "Degraded",
  stale: "Stale",
  unknown: "Unknown",
  skipped: "Skipped",
}

// Readable text colour over each solid STATUS_COLOR, so the normal badge and
// the racing-flag badge share one palette.
export const STATUS_TEXT: Record<CheckStatus, string> = {
  up: "#ffffff",
  down: "#ffffff",
  degraded: "#422006", // dark amber on amber-500
  stale: "#ffffff",
  unknown: "#ffffff",
  skipped: "#3f3f46", // dark zinc on light zinc-300
}

export interface Slice {
  label: string
  value: number
  color: string
}

// A thin SVG donut + legend. No charting dependency — just stacked arc strokes,
// which keeps it perfectly on-token and light.
export function Donut({
  slices,
  size = 160,
  thickness = 16,
  centerLabel,
}: {
  slices: Slice[]
  size?: number
  thickness?: number
  centerLabel?: string
}) {
  const total = slices.reduce((a, s) => a + s.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0

  return (
    <div className="flex items-center gap-5">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-zinc-200)"
          className="dark:stroke-zinc-800"
          strokeWidth={thickness}
        />
        {total > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s, i) => {
              const len = (s.value / total) * c
              const el = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              )
              offset += len
              return el
            })}
        <text
          x="50%"
          y="47%"
          textAnchor="middle"
          className="fill-foreground text-2xl font-semibold"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {total}
        </text>
        {centerLabel && (
          <text
            x="50%"
            y="62%"
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="space-y-1 text-[13px]">
        {slices
          .filter((s) => s.value > 0)
          .map((s) => (
            <li key={s.label} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-[3px]"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-foreground">{s.label}</span>
              <span className="num ml-auto pl-4 text-muted-foreground">
                {s.value}
              </span>
            </li>
          ))}
        {total === 0 && (
          <li className="text-muted-foreground">No checks yet.</li>
        )}
      </ul>
    </div>
  )
}

// Horizontal bars for a small categorical breakdown (e.g. checks by kind).
export function MiniBars({
  rows,
}: {
  rows: { label: string; value: number }[]
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No data.</p>
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-[13px]">
          <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground uppercase">
            {r.label}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded-sm bg-muted">
            <div
              className="h-full rounded-sm bg-primary"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
          <span className="num w-10 text-right text-muted-foreground">
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}
