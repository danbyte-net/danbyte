import { useMemo, type MouseEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"

import {
  api,
  type ComplianceEvaluation,
  type ComplianceSeverity,
  type ComplianceViolation,
} from "@/lib/api"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Worst-first ordering so a critical always wins the tint.
const SEVERITY_RANK: Record<ComplianceSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
}

const SEVERITY_TONE: Record<ComplianceSeverity, string> = {
  critical: "text-red-500 dark:text-red-400",
  warning: "text-amber-500 dark:text-amber-400",
  info: "text-zinc-400 dark:text-zinc-500",
}

// The `prominent` variant — a filled status pill for detail-page heroes, where a
// violation should be noticed (unlike the deliberately-quiet table marker).
const SEVERITY_PILL: Record<ComplianceSeverity, string> = {
  critical:
    "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/20",
  warning:
    "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/20",
  info: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/20",
}

// One Map per violations array, cached by array identity. react-query hands
// back a stable reference for cached data, so every <ViolationBadge> on the
// page — even one per table row — reuses the same Map instead of rebuilding.
const _mapCache = new WeakMap<
  ComplianceViolation[],
  Map<string, ComplianceViolation[]>
>()

function buildMap(violations: ComplianceViolation[]) {
  const cached = _mapCache.get(violations)
  if (cached) return cached
  const map = new Map<string, ComplianceViolation[]>()
  for (const v of violations) {
    const arr = map.get(v.object_id)
    if (arr) arr.push(v)
    else map.set(v.object_id, [v])
  }
  _mapCache.set(violations, map)
  return map
}

/**
 * Shared compliance evaluation, keyed so every <ViolationBadge> on a page
 * dedupes to one request. Returns a Map from object id → its violations.
 * Compliance violations are computed (not stored), so we lean on react-query
 * caching rather than re-evaluating per object.
 */
export function useViolationMap() {
  const q = useQuery({
    queryKey: ["compliance-evaluate"],
    queryFn: () => api<ComplianceEvaluation>("/api/compliance/evaluate/"),
    staleTime: 2 * 60_000,
    // A compliance pass can be heavy; don't refetch on every focus.
    refetchOnWindowFocus: false,
  })

  return useMemo(() => buildMap(q.data?.violations ?? []), [q.data])
}

function worstSeverity(violations: ComplianceViolation[]): ComplianceSeverity {
  return violations.reduce<ComplianceSeverity>(
    (worst, v) =>
      SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst] ? v.severity : worst,
    "info"
  )
}

export interface ViolationBadgeProps {
  /** UUID of the object to look up. */
  objectId: string
  /** The object's compliance object type. Devices get a dedicated per-device
   * compliance page, so `objectType="device"` routes the marker there instead
   * of the global Compliance list. */
  objectType?: string
  /** Pre-resolved map (pass it from a list to avoid one hook per row). When
   * omitted the component subscribes to the shared evaluation itself. */
  map?: Map<string, ComplianceViolation[]>
  /** Render a filled, labelled pill (with the violation count) instead of the
   * quiet bare triangle. Use on detail-page heroes where it must be noticed. */
  prominent?: boolean
  className?: string
}

/**
 * A deliberately quiet compliance-violation marker: a small triangle tinted by
 * the worst severity, with a tooltip naming the failing rules and a link to the
 * Compliance page. Renders nothing when the object is clean — so it can be
 * dropped next to any name or title without disturbing compliant rows.
 */
export function ViolationBadge({
  objectId,
  objectType,
  map,
  prominent,
  className,
}: ViolationBadgeProps) {
  // Hooks must run unconditionally; when a map is supplied we still call the
  // shared hook but it dedupes to the same cached query.
  const ownMap = useViolationMap()
  const source = map ?? ownMap
  const violations = source.get(objectId)
  if (!violations || violations.length === 0) return null

  const severity = worstSeverity(violations)
  const n = violations.length
  const label = `${n} compliance violation${n === 1 ? "" : "s"}`

  const linkClass = cn(
    prominent
      ? cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
          SEVERITY_PILL[severity]
        )
      : cn(
          "inline-flex shrink-0 items-center align-middle",
          SEVERITY_TONE[severity]
        ),
    className
  )
  const stop = (e: MouseEvent) => e.stopPropagation()
  const inner = (
    <>
      <TriangleAlert className="h-3.5 w-3.5" />
      {prominent && <span className="num">{n}</span>}
    </>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {objectType === "device" ? (
          // Devices have a dedicated per-device compliance status page.
          <Link
            to="/devices/$id/compliance"
            params={{ id: objectId }}
            aria-label={label}
            className={linkClass}
            onClick={stop}
          >
            {inner}
          </Link>
        ) : (
          <Link
            to="/compliance"
            search={{ tab: "violations" }}
            aria-label={label}
            className={linkClass}
            onClick={stop}
          >
            {inner}
          </Link>
        )}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-xs flex-col items-start gap-0.5"
      >
        <span className="font-medium">
          {n} compliance {n === 1 ? "violation" : "violations"}
        </span>
        <ul className="mt-0.5 space-y-0.5">
          {violations.slice(0, 6).map((v) => (
            <li key={v.rule_id} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  v.severity === "critical"
                    ? "bg-red-500"
                    : v.severity === "warning"
                      ? "bg-amber-500"
                      : "bg-zinc-400"
                )}
              />
              {v.rule_name}
            </li>
          ))}
          {n > 6 && <li className="opacity-70">+{n - 6} more…</li>}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
