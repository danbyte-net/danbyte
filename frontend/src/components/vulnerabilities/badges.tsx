import { Link } from "@tanstack/react-router"

import type {
  DecimalValue,
  HostVulnerabilitySummary,
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
// Badge, one variant per level; never a dot or a hand-rolled pill. One
// colour scale for both: solid red, soft red, yellow, green, plain.

type Variant =
  "destructive-solid" | "destructive" | "warning" | "success" | "outline"

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
  fix_first: "destructive-solid",
  high: "destructive",
  medium: "warning",
  low: "success",
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
  critical: "destructive-solid",
  high: "destructive",
  medium: "warning",
  low: "success",
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

/** "N open · M fix first · K KEV" - the host badge's hover. */
export function hostVulnSummaryText(s: HostVulnerabilitySummary): string {
  return `${s.open} open · ${s.fix_first} fix first · ${s.kev} KEV`
}

/** "Critical 9.8" - the worst open severity and the top score. */
export function hostVulnLabel(s: HostVulnerabilitySummary): string {
  const n = toNumber(s.max_cvss)
  const sev = s.worst_severity ? SEVERITY_LABELS[s.worst_severity] : "Unscored"
  return n === null ? sev : `${sev} ${n.toFixed(1)}`
}

/**
 * A host's open vulnerabilities as one severity badge with the top score,
 * linked to its Vulnerabilities tab; the counts on hover. Nothing while the
 * summary is null (the feature is off) or nothing is open.
 */
export function HostVulnBadge({
  summary,
  kind,
  id,
  compact = false,
}: {
  summary: HostVulnerabilitySummary | null | undefined
  kind: "device" | "virtual_machine"
  id: string
  /** The score alone ("9.8"), for a column whose header names it. */
  compact?: boolean
}) {
  if (!summary || summary.open === 0) return null
  const variant = summary.worst_severity
    ? SEVERITY_VARIANT[summary.worst_severity]
    : "outline"
  const top = toNumber(summary.max_cvss)
  const label =
    compact && top !== null ? top.toFixed(1) : hostVulnLabel(summary)
  const search = { tab: "vulnerabilities" as const }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className="num" asChild>
          {kind === "device" ? (
            <Link to="/devices/$id" params={{ id }} search={search}>
              {label}
            </Link>
          ) : (
            <Link to="/virtual-machines/$id" params={{ id }} search={search}>
              {label}
            </Link>
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        {hostVulnSummaryText(summary)}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A package's open CVEs on one host (#451): the count on the worst
 * severity's badge, linked to the host's Vulnerabilities tab narrowed to the
 * package (`?vpackage=`). A dash with none.
 */
export function PackageCveBadge({
  cves,
  kind,
  id,
  packageId,
}: {
  cves: { count: number; severity: VulnSeverity } | null | undefined
  kind: "device" | "virtual_machine"
  id: string
  packageId: string
}) {
  if (!cves || cves.count === 0) return dash
  const variant = cves.severity ? SEVERITY_VARIANT[cves.severity] : "outline"
  const search = { tab: "vulnerabilities", vpackage: packageId } as never
  const label = `${cves.count}`
  const name = cves.severity
    ? `${cves.count} open, worst ${SEVERITY_LABELS[cves.severity]}`
    : `${cves.count} open`
  return (
    <Badge variant={variant} className="num" asChild>
      {kind === "device" ? (
        <Link
          to="/devices/$id"
          params={{ id }}
          search={search}
          aria-label={name}
        >
          {label}
        </Link>
      ) : (
        <Link
          to="/virtual-machines/$id"
          params={{ id }}
          search={search}
          aria-label={name}
        >
          {label}
        </Link>
      )}
    </Badge>
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
