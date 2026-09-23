import type { CheckFigures } from "@/lib/api"
import { cn } from "@/lib/utils"

/** 99.95 and up keep two decimals - that is where the nines are told apart. */
export function fmtPct(p: number | null | undefined): string {
  return p == null ? "-" : `${p.toFixed(p >= 99.95 ? 2 : 1)}%`
}

/** The tiers the daily bars colour by: three nines, two nines, less. */
export function availabilityTone(p: number | null | undefined): string {
  if (p == null) return "text-muted-foreground"
  if (p >= 99.9) return "text-emerald-600 dark:text-emerald-400"
  if (p >= 99) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "-"
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
}

/**
 * Availability as a table cell: the figure in its tier, and the coverage
 * beside it when part of the window went unmeasured - 100% over two days of
 * seven is not the same claim as 100% over seven.
 */
export function AvailabilityCell({
  figures,
  className,
}: {
  figures: Pick<CheckFigures, "availability" | "coverage"> | undefined
  className?: string
}) {
  if (!figures || figures.availability == null)
    return <span className="text-muted-foreground">-</span>
  const partial = figures.coverage != null && figures.coverage < 99
  return (
    <span className={cn("num inline-flex items-baseline gap-1.5", className)}>
      <span className={availabilityTone(figures.availability)}>
        {fmtPct(figures.availability)}
      </span>
      {partial && (
        <span className="text-[11px] text-muted-foreground">
          {Math.round(figures.coverage!)}% seen
        </span>
      )}
    </span>
  )
}
