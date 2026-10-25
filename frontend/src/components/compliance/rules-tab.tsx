import { useMemo, useState } from "react"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { UseQueryResult } from "@tanstack/react-query"

import type {
  ComplianceRule,
  ComplianceRuleResult,
  ComplianceSummary,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { actionsColumn } from "@/components/columns/actions-column"
import { ruleColumns } from "@/components/columns/compliance-columns"

import { SeverityBadge } from "./compliance-shared"
import {
  normalizeComplianceSearch,
  sortRulesWorstFirst,
} from "./compliance-search"
import type { ComplianceSearch, RuleGrouping } from "./compliance-search"
import { DeleteRule } from "./delete-rule-dialog"

/** `/compliance?tab=rules` - every rule, enabled or not, with its live
 * result; worst first, grouped by severity or object type on request. */
export function RulesTab({
  summary,
}: {
  summary: UseQueryResult<ComplianceSummary>
}) {
  const search = useSearch({ from: "/compliance" })
  const nav = useNavigate()
  const { canDo } = useMe()
  const canAdd = canDo("compliancerule", "add")
  const canEdit = canDo("compliancerule", "change")
  const canDelete = canDo("compliancerule", "delete")
  const q = useQuery({
    queryKey: ["compliance-rules"],
    queryFn: () => apiAll<ComplianceRule>("/api/compliance-rules/"),
  })
  const [deleting, setDeleting] = useState<ComplianceRule | null>(null)
  const by: RuleGrouping = search.by ?? "none"

  const results = useMemo(() => {
    const m = new Map<string, ComplianceRuleResult>()
    for (const r of summary.data?.rules ?? []) m.set(r.id, r)
    return m
  }, [summary.data])

  // Worst first by default; a header click re-sorts in the table.
  const rows = useMemo(() => {
    const list = q.data?.results ?? []
    const keyed = list.map((r) => ({
      rule: r,
      name: r.name,
      severity: r.severity,
      violations: r.enabled ? (results.get(r.id)?.violations ?? 0) : -1,
      open: r.enabled ? (results.get(r.id)?.open ?? 0) : -1,
    }))
    return sortRulesWorstFirst(keyed).map((k) => k.rule)
  }, [q.data, results])

  const columns = useMemo(
    () => [
      ...ruleColumns({ results }),
      actionsColumn<ComplianceRule>({
        editTo: "/compliance-rules/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete: setDeleting,
        canDelete: () => canDelete,
      }),
    ],
    [results, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Compliance"
      count={q.data ? rows.length : undefined}
      actions={
        <>
          <span className="text-xs text-muted-foreground">Group</span>
          <SegmentedTabs<RuleGrouping>
            value={by}
            onValueChange={(v) =>
              nav({
                to: "/compliance",
                search: (prev): ComplianceSearch => ({
                  ...normalizeComplianceSearch(prev),
                  by: v === "none" ? undefined : v,
                }),
                replace: true,
              })
            }
            items={[
              { value: "none", label: "None" },
              { value: "severity", label: "Severity" },
              { value: "type", label: "Object type" },
            ]}
          />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/compliance-rules/new">Add rule</Link>
            </Button>
          )}
        </>
      }
      query={q}
    >
      {rows.length === 0 ? (
        <EmptyState title="No compliance rules yet.">
          Add one and every matching object is checked against it.
        </EmptyState>
      ) : (
        <DataTable
          // Grouping is fixed when the table mounts.
          key={by}
          data={rows}
          total={q.data?.count}
          columns={columns}
          flexColumn="check"
          tableId="compliance-rules"
          exportName="compliance-rules"
          exportTitle="Compliance rules"
          groupBy={
            by === "severity"
              ? "severity"
              : by === "type"
                ? "applies"
                : undefined
          }
          pagedWhenGrouped
          renderGroupHeader={({ count, sampleRow }) => (
            <span className="inline-flex items-center gap-2 tracking-normal normal-case">
              {by === "severity" ? (
                <SeverityBadge severity={sampleRow.severity} />
              ) : (
                <span className="text-[13px] font-medium text-foreground">
                  {sampleRow.object_type_label}
                </span>
              )}
              <Badge variant="secondary">
                {count} rule{count === 1 ? "" : "s"}
              </Badge>
            </span>
          )}
        />
      )}

      <DeleteRule
        rule={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
