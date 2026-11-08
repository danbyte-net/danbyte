import { cn } from "@/lib/utils"

/** Where a band starts: values below `below` or above `above` are in it.
 * Either side may be missing - a disk's free space only warns low, a
 * response time only high. */
export interface GaugeBand {
  below?: number | null
  above?: number | null
}

export type GaugeTone = "ok" | "warning" | "error" | "neutral"

/** Which band a value falls in. Error wins over warning; with no bands at
 * all a value has no verdict and reads neutral. */
export function gaugeTone(
  value: number | null | undefined,
  warn?: GaugeBand,
  error?: GaugeBand
): GaugeTone {
  if (value == null || Number.isNaN(value)) return "neutral"
  const hit = (b?: GaugeBand) =>
    !!b &&
    ((b.below != null && value < b.below) ||
      (b.above != null && value > b.above))
  if (hit(error)) return "error"
  if (hit(warn)) return "warning"
  const has = (b?: GaugeBand) => !!b && (b.below != null || b.above != null)
  return has(warn) || has(error) ? "ok" : "neutral"
}

/** The number as an operator reads it: fewer decimals as it grows. */
export function formatGaugeValue(v: number): string {
  const abs = Math.abs(v)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(v)
}

// Stroke classes per tone: the status families the Badge variants use, so a
// red arc and a red badge are the same red. Never the accent.
const TONE_STROKE: Record<GaugeTone, string> = {
  ok: "stroke-emerald-500 dark:stroke-emerald-400",
  warning: "stroke-amber-500 dark:stroke-amber-400",
  error: "stroke-destructive",
  neutral: "stroke-foreground/45",
}

const CX = 60
const CY = 58
const R = 46 // the value track
const RB = 54 // the thin band arcs, just outside it

function point(frac: number, r: number) {
  const a = Math.PI * (1 - frac)
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)] as const
}

function arc(f0: number, f1: number, r: number): string {
  const [x0, y0] = point(f0, r)
  const [x1, y1] = point(f1, r)
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

/**
 * An arc gauge: a half-circle track, the value as an arc and as the big
 * number with its unit, the warning and error zones as thin arcs outside the
 * track in the warning and destructive colours, and min and max at the ends.
 * No needle. The value arc takes the colour of the zone the value is in, and
 * stays neutral when there are no zones - colour only when it means
 * something.
 *
 * Shared: the PRTG sensor panel draws channels with it, and Danbyte's own
 * checks can hand it a value and their thresholds the same way.
 */
export function Gauge({
  value,
  unit = "",
  min = 0,
  max = 100,
  warn,
  error,
  label,
  className,
}: {
  value: number | null | undefined
  unit?: string
  min?: number
  max?: number
  /** Values below / above these are a warning. */
  warn?: GaugeBand
  /** Values below / above these are an error. */
  error?: GaugeBand
  /** What is measured, for assistive tech (the card names it visibly). */
  label?: string
  className?: string
}) {
  const span = max > min ? max - min : 1
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / span))
  const tone = gaugeTone(value, warn, error)
  // Zones as [from, to] fractions. A warning zone stops where the error zone
  // starts, so the two never overlap.
  const zones: { tone: "warning" | "error"; from: number; to: number }[] = []
  if (error?.below != null)
    zones.push({ tone: "error", from: 0, to: frac(error.below) })
  if (error?.above != null)
    zones.push({ tone: "error", from: frac(error.above), to: 1 })
  if (warn?.below != null) {
    const from = error?.below != null ? frac(error.below) : 0
    zones.push({ tone: "warning", from, to: frac(warn.below) })
  }
  if (warn?.above != null) {
    const to = error?.above != null ? frac(error.above) : 1
    zones.push({ tone: "warning", from: frac(warn.above), to })
  }
  const shown = value == null || Number.isNaN(value) ? null : value

  return (
    <div
      className={cn("relative w-full max-w-[180px]", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown ?? undefined}
      aria-valuetext={
        shown == null ? "No data" : `${formatGaugeValue(shown)} ${unit}`.trim()
      }
      data-tone={tone}
    >
      <svg viewBox="0 0 120 72" className="block w-full" aria-hidden="true">
        <path
          d={arc(0, 1, R)}
          fill="none"
          className="stroke-muted"
          strokeWidth={9}
        />
        {shown != null && frac(shown) > 0 && (
          <path
            d={arc(0, frac(shown), R)}
            fill="none"
            className={TONE_STROKE[tone]}
            strokeWidth={9}
            data-part="value"
          />
        )}
        {zones
          .filter((z) => z.to > z.from)
          .map((z, i) => (
            <path
              key={i}
              d={arc(z.from, z.to, RB)}
              fill="none"
              className={TONE_STROKE[z.tone]}
              strokeWidth={2.5}
              data-part={`band-${z.tone}`}
            />
          ))}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-[14%] text-center leading-none">
        <span className="num text-xl font-semibold tracking-tight">
          {shown == null ? "-" : formatGaugeValue(shown)}
        </span>
        {unit && shown != null && (
          <span className="ml-0.5 text-xs text-muted-foreground">{unit}</span>
        )}
      </div>
      <div className="num flex justify-between px-[4%] pb-2 text-[10px] text-muted-foreground">
        <span data-part="min">{formatGaugeValue(min)}</span>
        <span data-part="max">{formatGaugeValue(max)}</span>
      </div>
    </div>
  )
}
