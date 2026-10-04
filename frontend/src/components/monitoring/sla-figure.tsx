import type { SlaFigures, SlaState } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { fmtSpan } from "./status-strip"

const VARIANT: Record<
  SlaState,
  "success" | "warning" | "destructive" | "secondary"
> = {
  ok: "success",
  at_risk: "warning",
  breached: "destructive",
  no_data: "secondary",
  not_started: "secondary",
}

export const SLA_STATE_LABEL: Record<SlaState, string> = {
  ok: "On target",
  at_risk: "At risk",
  breached: "Breached",
  no_data: "No data",
  not_started: "Not started",
}

/** 99.95 and up keep three decimals - an SLA is argued in the last nine. */
export function fmtSla(p: number | null | undefined): string {
  if (p == null) return "-"
  return `${p.toFixed(p >= 99.95 ? 3 : p >= 99 ? 2 : 1)}%`
}

/**
 * An agreement's figure as a badge, coloured against its own target: on
 * target green, inside the warning band amber, below it red. A dashed
 * outline when less than 90 % of the time was measured - never faded, which
 * turned the red muddy on the dark theme.
 */
export function SlaFigureBadge({
  figures,
}: {
  figures:
    | Pick<SlaFigures, "availability" | "state" | "coverage">
    | null
    | undefined
}) {
  if (!figures || figures.availability == null)
    return <span className="text-muted-foreground">-</span>
  const low = figures.coverage != null && figures.coverage < 90
  return (
    <Badge
      variant={VARIANT[figures.state]}
      className={`num font-medium ${low ? "border-dashed border-current/60" : ""}`}
    >
      {fmtSla(figures.availability)}
    </Badge>
  )
}

export function SlaStateBadge({ state }: { state: SlaState }) {
  return <Badge variant={VARIANT[state]}>{SLA_STATE_LABEL[state]}</Badge>
}

/** Budget left as time, negative once overspent. */
export function fmtBudget(seconds: number): string {
  return seconds < 0 ? `-${fmtSpan(-seconds * 1000)}` : fmtSpan(seconds * 1000)
}

export const PERIOD_LABEL: Record<string, string> = {
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  rolling_7: "Last 7 days",
  rolling_30: "Last 30 days",
  rolling_90: "Last 90 days",
}
