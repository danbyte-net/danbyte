import { useEffect, useMemo, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import type { UseQueryResult } from "@tanstack/react-query"
import { X } from "lucide-react"

import type { ComplianceEvaluation, ComplianceViolation } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import {
  FacetGroup,
  FilterRail,
  tagObjectsLink,
  toggleInSet,
} from "@/components/filter-rail"
import type { FacetOption } from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import type { FilterSnapshot } from "@/components/table-filters"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { violationColumns } from "@/components/columns/compliance-columns"

import { SEVERITY_RANK, SeverityBadge, countOf } from "./compliance-shared"
import {
  VIOLATION_FILTER_KEYS,
  csvSet,
  normalizeComplianceSearch,
} from "./compliance-search"
import type { ComplianceSearch } from "./compliance-search"
import { TriageBar } from "./triage-bar"

/** A violation keyed by its rule and object, so a ticked row stays ticked
 * across a refetch or a filter change. */
type Row = ComplianceViolation & { id: string }

const STATE_RANK = { open: 0, snoozed: 1, acknowledged: 2 } as const

/** Worst first: severity, open before triaged, then rule and object. */
export function sortViolations<T extends ComplianceViolation>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      STATE_RANK[a.state ?? "open"] - STATE_RANK[b.state ?? "open"] ||
      a.rule_name.localeCompare(b.rule_name) ||
      a.object_repr.localeCompare(b.object_repr, undefined, { numeric: true })
  )
}

/** The URL filters applied to the violation list - the same rules as the
 * evaluate endpoint's query params. */
export function matchViolation(
  v: ComplianceViolation,
  s: Pick<ComplianceSearch, (typeof VIOLATION_FILTER_KEYS)[number] | "q">
): boolean {
  const has = (param: string | undefined, value: string) =>
    !param || csvSet(param).has(value)
  if (!has(s.severity, v.severity)) return false
  if (!has(s.type, v.object_type)) return false
  if (!has(s.rule, v.rule_id)) return false
  if (!has(s.state, v.state ?? "open")) return false
  if (!has(s.site, v.site_id ?? "none")) return false
  if (s.device && v.object_id !== s.device) return false
  if (s.tag) {
    const want = csvSet(s.tag)
    if (!(v.tags ?? []).some((t) => want.has(t))) return false
  }
  const needle = (s.q ?? "").trim().toLowerCase()
  if (
    needle &&
    !v.object_repr.toLowerCase().includes(needle) &&
    !v.rule_name.toLowerCase().includes(needle)
  )
    return false
  return true
}

/** `/compliance?tab=violations` - every failing rule/object pair on a
 * filter rail, grouped by rule on request, ticked rows triaged in bulk. */
export function ViolationsTab({
  query,
}: {
  query: UseQueryResult<ComplianceEvaluation>
}) {
  const search = useSearch({ from: "/compliance" })
  const nav = useNavigate()
  const { canDo } = useMe()
  const canTriage = canDo("compliancetriage", "change")
  const [selected, setSelected] = useState<Row[]>([])

  const patch = (p: Partial<ComplianceSearch>) =>
    nav({
      to: "/compliance",
      search: (prev) => ({ ...normalizeComplianceSearch(prev), ...p }),
      replace: true,
    })

  const urlQ = search.q ?? ""
  const [draft, setDraft] = useState(urlQ)
  useEffect(() => setDraft(urlQ), [urlQ])
  useEffect(() => {
    if (draft === urlQ) return
    const t = setTimeout(() => patch({ q: draft || undefined }), 300)
    return () => clearTimeout(t)
  }, [draft])

  const data = query.data
  const all = useMemo<Row[]>(
    () =>
      sortViolations(
        (data?.violations ?? []).map((v) => ({
          ...v,
          id: `${v.rule_id}:${v.object_id}`,
        }))
      ),
    [data]
  )
  const rows = useMemo(
    () => all.filter((v) => matchViolation(v, search)),
    [all, search]
  )
  const grouped = search.group === "rule"
  const columns = useMemo(
    () => violationColumns<Row>({ select: canTriage }),
    [canTriage]
  )

  const facets = data?.facets
  const facet = (
    key: (typeof VIOLATION_FILTER_KEYS)[number],
    label: string,
    options: FacetOption[] | undefined
  ) => {
    const sel = csvSet(search[key])
    return (
      <FacetGroup
        label={label}
        options={options ?? []}
        selected={sel}
        onToggle={(v) => {
          toggleInSet(sel, v, (next) =>
            patch({ [key]: next.size ? [...next].join(",") : undefined })
          )
        }}
      />
    )
  }

  // A deep link to a rule or object the rail does not list (nothing of it
  // shows) still needs a way out: a dismissible chip.
  const ruleIds = csvSet(search.rule)
  const unlistedRule =
    ruleIds.size > 0 &&
    [...ruleIds].some((id) => !facets?.rule.some((o) => o.value === id))
  const deviceLabel = search.device
    ? (all.find((v) => v.object_id === search.device)?.object_repr ?? "Object")
    : null

  const snapshot = (): FilterSnapshot => {
    const out: FilterSnapshot = {}
    for (const k of VIOLATION_FILTER_KEYS) if (search[k]) out[k] = search[k]!
    if (grouped) out.group = "rule"
    return out
  }
  const restore = (snap: FilterSnapshot | null | undefined) => {
    const next: Partial<ComplianceSearch> = { group: undefined }
    for (const k of VIOLATION_FILTER_KEYS) next[k] = undefined
    for (const [k, v] of Object.entries(snap ?? {})) {
      const val = Array.isArray(v) ? v.join(",") : v
      if (typeof val === "string" && val)
        (next as Record<string, string>)[k] = val
    }
    patch(next)
  }
  const activeCount =
    VIOLATION_FILTER_KEYS.filter((k) => search[k]).length + (grouped ? 1 : 0)

  return (
    <ListPageShell
      title="Compliance"
      count={data ? rows.length : undefined}
      rail={
        <FilterRail>
          {facet("state", "State", facets?.state)}
          {facet("severity", "Severity", facets?.severity)}
          {facet("rule", "Rule", facets?.rule)}
          {facet("type", "Object type", facets?.object_type)}
          {facet("site", "Site", facets?.site)}
          {facet(
            "tag",
            "Tags",
            facets?.tag.map((o) => ({
              value: o.value,
              label: o.label,
              count: o.count,
              color: o.color || undefined,
              textColor: o.text_color || undefined,
              link: o.id != null ? tagObjectsLink(o.id) : undefined,
            }))
          )}
        </FilterRail>
      }
      search={{
        value: draft,
        onChange: setDraft,
        placeholder: "Search object or rule…",
      }}
      savedViews={{
        objectType: "compliance-violation",
        filters: { snapshot, restore, activeCount },
      }}
      actions={
        <>
          {unlistedRule && (
            <FilterChip
              label="Rule"
              value={
                ruleIds.size === 1
                  ? (data?.rules.find((r) => ruleIds.has(r.id))?.name ?? "Rule")
                  : `${ruleIds.size} rules`
              }
              onClear={() => patch({ rule: undefined })}
            />
          )}
          {deviceLabel && (
            <FilterChip
              label="Object"
              value={deviceLabel}
              onClear={() => patch({ device: undefined })}
            />
          )}
          <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
            <Switch
              checked={grouped}
              onCheckedChange={(v) => patch({ group: v ? "rule" : undefined })}
            />
            Group by rule
          </label>
        </>
      }
      query={query}
    >
      {data && data.rules.length === 0 ? (
        <EmptyState title="No enabled rules yet.">
          Add one in <span className="font-medium">Rules</span> to start
          checking.
        </EmptyState>
      ) : data && data.total_violations === 0 ? (
        <EmptyState title="All rules pass.">
          Nothing out of compliance right now.
        </EmptyState>
      ) : (
        <DataTable<Row>
          // Grouping is fixed when the table mounts.
          key={grouped ? "grouped" : "flat"}
          data={rows}
          columns={columns}
          flexColumn="object"
          tableId="compliance-violations"
          exportName="compliance-violations"
          exportTitle="Compliance violations"
          groupBy={grouped ? "rule" : undefined}
          pagedWhenGrouped
          initialColumnVisibility={grouped ? { rule: false } : undefined}
          renderGroupHeader={({ count, sampleRow }) => (
            <span className="inline-flex items-center gap-2 tracking-normal normal-case">
              <SeverityBadge severity={sampleRow.severity} />
              <span className="text-[13px] font-medium text-foreground">
                {sampleRow.rule_name}
              </span>
              <Badge variant="secondary">
                {countOf(sampleRow.object_type, count)}
              </Badge>
            </span>
          )}
          onSelectedRowsChange={canTriage ? setSelected : undefined}
          selectedRows={canTriage ? selected : undefined}
        />
      )}
      {canTriage && (
        <TriageBar selected={selected} onDone={() => setSelected([])} />
      )}
    </ListPageShell>
  )
}

/** A dismissible chip for a deep-link filter the rail does not show. */
function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string
  value: string
  onClear: () => void
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted/40 pr-1 pl-2 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-40 truncate font-medium">{value}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label.toLowerCase()} filter`}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
