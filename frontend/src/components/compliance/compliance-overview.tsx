import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import type { UseQueryResult } from "@tanstack/react-query"
import { Search } from "lucide-react"

import type { ComplianceSeverity, ComplianceSummary } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Kpi } from "@/components/kpi-card"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DataTable } from "@/components/data-table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  RuleLink,
  RuleResult,
  offenderColumns,
} from "@/components/columns/compliance-columns"

import {
  CONFIG_DRIFT_RULE_ID,
  SEVERITIES,
  SEVERITY_LABEL,
  SeverityBadge,
  ruleSummary,
} from "./compliance-shared"
import {
  filterRules,
  groupRules,
  normalizeComplianceSearch,
  sortRulesWorstFirst,
} from "./compliance-search"
import type {
  ComplianceSearch,
  RuleGrouping,
  RuleRow,
} from "./compliance-search"

const SEV_TONE: Record<ComplianceSeverity, "danger" | "warning" | "muted"> = {
  critical: "danger",
  warning: "warning",
  info: "muted",
}

/**
 * `/compliance` (Overview) - the page a security team opens first: the
 * estate's figures on top, one card per rule worst first, and the objects
 * failing the most rules. Every figure and count opens the Violations tab
 * filtered to what it counts.
 */
export function ComplianceOverview({
  query,
}: {
  query: UseQueryResult<ComplianceSummary>
}) {
  const search = useSearch({ from: "/compliance" })
  const nav = useNavigate()
  const { canDo } = useMe()
  const patch = (p: Partial<ComplianceSearch>) =>
    nav({
      to: "/compliance",
      search: (prev) => ({ ...normalizeComplianceSearch(prev), ...p }),
      replace: true,
    })
  const violations = (p: Partial<ComplianceSearch>) =>
    nav({ to: "/compliance", search: { tab: "violations", ...p } })

  // The rule search box types freely and lands in the URL after a pause.
  const urlQ = search.rq ?? ""
  const [q, setQ] = useState(urlQ)
  useEffect(() => setQ(urlQ), [urlQ])
  useEffect(() => {
    if (q === urlQ) return
    const t = setTimeout(() => patch({ rq: q || undefined }), 300)
    return () => clearTimeout(t)
  }, [q])

  const d = query.data
  const by: RuleGrouping = search.by ?? "none"
  const failingOnly = search.failing === "1"
  const groups = useMemo(
    () =>
      groupRules(
        filterRules(sortRulesWorstFirst(d?.rules ?? []), {
          q: urlQ,
          failingOnly,
        }),
        by
      ),
    [d, urlQ, failingOnly, by]
  )
  const shown = groups.reduce((n, g) => n + g.rows.length, 0)
  const offenderCols = useMemo(() => offenderColumns(), [])

  if (query.isError) return <QueryError error={query.error} />
  if (!d) return <Loading />

  const t = d.totals
  if (t.rules === 0)
    return (
      <EmptyState
        title={
          t.disabled_rules > 0
            ? "Every rule is disabled."
            : "No compliance rules yet."
        }
      >
        {canDo("compliancerule", "add") && (
          <Button size="sm" className="mt-3" asChild>
            <Link to="/compliance-rules/new">Add rule</Link>
          </Button>
        )}
      </EmptyState>
    )

  return (
    <div className="mx-auto max-w-7xl space-y-4 lg:space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:gap-4 xl:grid-cols-7">
        <Kpi
          label="Rules"
          value={t.rules}
          onClick={() => nav({ to: "/compliance", search: { tab: "rules" } })}
        />
        <Kpi
          label="Passing"
          value={t.passing}
          tone={t.passing > 0 ? "success" : undefined}
        />
        <Kpi
          label="With violations"
          value={t.failing}
          tone={t.failing > 0 ? "danger" : undefined}
          active={failingOnly}
          onClick={() => patch({ failing: failingOnly ? undefined : "1" })}
        />
        <Kpi
          label="Objects in violation"
          value={t.objects_in_violation}
          badge={t.acknowledged + t.snoozed > 0 ? `${t.open} open` : undefined}
          onClick={() => violations({ state: "open" })}
        />
        {SEVERITIES.map((s) => (
          <Kpi
            key={s}
            label={SEVERITY_LABEL[s]}
            value={d.by_severity[s].open}
            tone={d.by_severity[s].open > 0 ? SEV_TONE[s] : undefined}
            badge={
              d.by_severity[s].failing_rules
                ? `${d.by_severity[s].failing_rules} rule${
                    d.by_severity[s].failing_rules === 1 ? "" : "s"
                  }`
                : undefined
            }
            onClick={() => violations({ severity: s, state: "open" })}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>Worst first</CardDescription>
          <div className="col-span-full mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search rules…"
                aria-label="Search rules"
                className="h-8 pl-8"
              />
            </div>
            <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
              <Switch
                checked={failingOnly}
                onCheckedChange={(v) => patch({ failing: v ? "1" : undefined })}
              />
              Hide passing
            </label>
            <div className="flex items-center gap-2 sm:ml-auto">
              <span className="text-xs text-muted-foreground">Group</span>
              <SegmentedTabs<RuleGrouping>
                value={by}
                onValueChange={(v) =>
                  patch({ by: v === "none" ? undefined : v })
                }
                items={[
                  { value: "none", label: "None" },
                  { value: "severity", label: "Severity" },
                  { value: "type", label: "Object type" },
                ]}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {shown === 0 ? (
            <EmptyState
              title={
                failingOnly && !urlQ ? "Every rule passes." : "No rules match."
              }
            />
          ) : (
            groups.map((g) => (
              <section key={g.key} className="space-y-2">
                {g.label && (
                  <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {g.label}
                    <span className="font-normal tracking-normal normal-case">
                      {g.rows.length}
                    </span>
                  </h3>
                )}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {g.rows.map((r) => (
                    <RuleCard key={r.id} rule={r} />
                  ))}
                </div>
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top offenders</CardTitle>
          <CardDescription>Objects failing the most rules</CardDescription>
        </CardHeader>
        <CardContent>
          {d.top_offenders.length === 0 ? (
            <EmptyState title="Nothing out of compliance." />
          ) : (
            <DataTable
              data={d.top_offenders}
              columns={offenderCols}
              flexColumn="rules"
              tableId="compliance-top-offenders"
              exportName="compliance-top-offenders"
              exportTitle="Compliance top offenders"
              embedded
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RuleCard({ rule: r }: { rule: RuleRow }) {
  const drift = r.id === CONFIG_DRIFT_RULE_ID
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 truncate">
          <RuleLink id={r.id} name={r.name} />
        </span>
        <SeverityBadge severity={r.severity} />
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {r.object_type_label}
        <span className="mx-1">·</span>
        {drift ? "live config matches intended" : ruleSummary(r)}
      </p>
      <div className="mt-auto pt-1">
        <RuleResult rule={r} />
      </div>
    </div>
  )
}
