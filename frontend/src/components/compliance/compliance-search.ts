import type { ComplianceSeverity, ComplianceSummary } from "@/lib/api"

import { SEVERITY_LABEL, SEVERITY_RANK } from "./compliance-shared"

export type ComplianceTab = "overview" | "violations" | "rules"
export type RuleGrouping = "none" | "type" | "severity"

/** The Compliance page's URL state. Every filter lives in the query string,
 * so a view is shareable, bookmarkable and survives back/forward. */
export interface ComplianceSearch {
  tab: ComplianceTab
  /** Violations: free text over object and rule name. */
  q?: string
  /** Violations: comma-separated severities (critical,warning,info). */
  severity?: string
  /** Violations: comma-separated object types (device,prefix,…). */
  type?: string
  /** Violations: comma-separated rule ids (or `config-drift`). */
  rule?: string
  /** Violations: a single object id (e.g. one device). */
  device?: string
  /** Violations: comma-separated site ids; `none` for no site. */
  site?: string
  /** Violations: comma-separated tag slugs. */
  tag?: string
  /** Violations: comma-separated triage states. */
  state?: string
  /** Violations: `rule` groups the rows under one header per rule. */
  group?: "rule"
  /** Overview: search over rule names. */
  rq?: string
  /** Overview: `1` hides the rules that pass. */
  failing?: "1"
  /** Overview and Rules: group the rules. */
  by?: Exclude<RuleGrouping, "none">
}

/** The violation filters a saved view captures and restores. */
export const VIOLATION_FILTER_KEYS = [
  "severity",
  "type",
  "rule",
  "device",
  "site",
  "tag",
  "state",
] as const
export type ViolationFilterKey = (typeof VIOLATION_FILTER_KEYS)[number]

const optStr = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined

export function normalizeComplianceSearch(
  s: Record<string, unknown>
): ComplianceSearch {
  const tab: ComplianceTab =
    s.tab === "violations" || s.tab === "rules" ? s.tab : "overview"
  return {
    tab,
    q: optStr(s.q),
    severity: optStr(s.severity),
    type: optStr(s.type),
    rule: optStr(s.rule),
    device: optStr(s.device),
    site: optStr(s.site),
    tag: optStr(s.tag),
    state: optStr(s.state),
    group: s.group === "rule" ? "rule" : undefined,
    rq: optStr(s.rq),
    failing: s.failing === "1" || s.failing === 1 ? "1" : undefined,
    by: s.by === "type" || s.by === "severity" ? s.by : undefined,
  }
}

/** A comma-separated param as a set. */
export const csvSet = (v: string | undefined): Set<string> =>
  new Set((v ?? "").split(",").filter(Boolean))

// ─── Rule cards ──────────────────────────────────────────────────────────────

export type RuleRow = ComplianceSummary["rules"][number]

/** Worst first: rules with open failures by severity, then by how many are
 * open, then by every failure, then by name. Passing rules last. */
export function sortRulesWorstFirst<
  TRow extends Pick<RuleRow, "severity" | "violations" | "name"> & {
    open?: number
  },
>(rows: TRow[]): TRow[] {
  const open = (r: TRow) => r.open ?? r.violations
  return [...rows].sort(
    (a, b) =>
      (open(b) > 0 ? SEVERITY_RANK[b.severity] : 0) -
        (open(a) > 0 ? SEVERITY_RANK[a.severity] : 0) ||
      open(b) - open(a) ||
      b.violations - a.violations ||
      a.name.localeCompare(b.name)
  )
}

export function filterRules<TRow extends Pick<RuleRow, "name" | "violations">>(
  rows: TRow[],
  { q, failingOnly }: { q?: string; failingOnly?: boolean }
): TRow[] {
  const needle = (q ?? "").trim().toLowerCase()
  return rows.filter(
    (r) =>
      (!failingOnly || r.violations > 0) &&
      (!needle || r.name.toLowerCase().includes(needle))
  )
}

export interface RuleGroup<TRow> {
  key: string
  label: string
  rows: TRow[]
}

/** Rules in groups, each group keeping the rows' order. Severity groups run
 * critical → info; object-type groups by their worst rule, as sorted. */
export function groupRules<
  TRow extends Pick<RuleRow, "object_type" | "severity"> & {
    object_type_label?: string
  },
>(rows: TRow[], by: RuleGrouping): RuleGroup<TRow>[] {
  if (by === "none") return [{ key: "all", label: "", rows }]
  const groups = new Map<string, RuleGroup<TRow>>()
  for (const r of rows) {
    const key = by === "type" ? r.object_type : r.severity
    const label =
      by === "type"
        ? (r.object_type_label ?? r.object_type)
        : SEVERITY_LABEL[r.severity]
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, label, rows: [] }))
    g.rows.push(r)
  }
  const out = [...groups.values()]
  if (by === "severity")
    out.sort(
      (a, b) =>
        SEVERITY_RANK[b.key as ComplianceSeverity] -
        SEVERITY_RANK[a.key as ComplianceSeverity]
    )
  return out
}
