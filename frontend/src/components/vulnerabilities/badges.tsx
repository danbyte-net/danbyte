import type {
  DecimalValue,
  VulnConfidence,
  VulnPriority,
  VulnSeverity,
} from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { dash } from "@/components/cells/dash"

// Severity, priority, KEV and confidence chips (#451). All on the squarish
// Badge, one variant per level; never a dot or a hand-rolled pill.

type Variant = "destructive" | "warning" | "secondary" | "outline"

export const PRIORITY_LABELS: Record<VulnPriority, string> = {
  fix_first: "Fix first",
  high: "High",
  medium: "Medium",
  low: "Low",
}

export const PRIORITY_ORDER: VulnPriority[] = [
  "fix_first",
  "high",
  "medium",
  "low",
]

const PRIORITY_VARIANT: Record<VulnPriority, Variant> = {
  fix_first: "destructive",
  high: "warning",
  medium: "secondary",
  low: "outline",
}

export type KnownSeverity = Exclude<VulnSeverity, "">

export const SEVERITY_LABELS: Record<KnownSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
}

export const SEVERITY_ORDER: KnownSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "none",
]

const SEVERITY_VARIANT: Record<KnownSeverity, Variant> = {
  critical: "destructive",
  high: "warning",
  medium: "secondary",
  low: "outline",
  none: "outline",
}

export const CONFIDENCE_LABELS: Record<VulnConfidence, string> = {
  exact: "Exact",
  range: "Range",
  partial: "Partial",
}

export function PriorityBadge({ value }: { value: VulnPriority | "" }) {
  if (!value) return dash
  return (
    <Badge variant={PRIORITY_VARIANT[value]}>{PRIORITY_LABELS[value]}</Badge>
  )
}

export function SeverityBadge({ value }: { value: VulnSeverity }) {
  if (!value) return dash
  return (
    <Badge variant={SEVERITY_VARIANT[value]}>{SEVERITY_LABELS[value]}</Badge>
  )
}

/** "KEV" when CISA lists the record as exploited; the dates on hover. */
export function KevBadge({
  added,
  due,
}: {
  added: string | null
  due: string | null
}) {
  const { formatDate } = useDateFormat()
  if (!added) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="destructive" tabIndex={0}>
          KEV
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        Known exploited since {formatDate(added)}
        {due ? ` · due ${formatDate(due)}` : ""}
      </TooltipContent>
    </Tooltip>
  )
}

/** Exact and range read as text; partial is a chip with why on hover. */
export function ConfidenceCell({ value }: { value: VulnConfidence }) {
  if (value !== "partial")
    return <span className="text-sm">{CONFIDENCE_LABELS[value]}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" tabIndex={0}>
          Partial
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        The record also names hardware or an OS that is not mapped here
      </TooltipContent>
    </Tooltip>
  )
}

export function toNumber(v: DecimalValue | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** CVSS score, one decimal. */
export function ScoreCell({ value }: { value: DecimalValue | null }) {
  const n = toNumber(value)
  if (n === null) return dash
  return <span className="num">{n.toFixed(1)}</span>
}

/** EPSS as a percentage, the way FIRST shows it. */
export function formatEpss(v: DecimalValue | null | undefined): string | null {
  const n = toNumber(v)
  if (n === null) return null
  const pct = n * 100
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2
  return `${pct.toFixed(digits)}%`
}

export function EpssCell({ value }: { value: DecimalValue | null }) {
  const s = formatEpss(value)
  if (s === null) return dash
  return <span className="num">{s}</span>
}
