import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, ShieldCheck } from "lucide-react"

import { api } from "@/lib/api"
import type { ComplianceEvaluation, ComplianceSummary } from "@/lib/api"
import { usePageTitle } from "@/lib/page-title"
import { Button } from "@/components/ui/button"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { ComplianceOverview } from "@/components/compliance/compliance-overview"
import { RulesTab } from "@/components/compliance/rules-tab"
import { ViolationsTab } from "@/components/compliance/violations-tab"
import { normalizeComplianceSearch } from "@/components/compliance/compliance-search"
import type {
  ComplianceSearch,
  ComplianceTab,
} from "@/components/compliance/compliance-search"

// Kept importable from here for the pages that already use them.
export {
  OBJ_ROUTE,
  SEV_VARIANT,
  ruleSummary,
} from "@/components/compliance/compliance-shared"
export { DeleteRule } from "@/components/compliance/delete-rule-dialog"

/** `/compliance` - Overview (default), Violations and Rules. Every filter is
 * URL state: `/compliance?tab=violations&rule=<id>&state=open`. */
export const Route = createFileRoute("/compliance")({
  component: CompliancePage,
  validateSearch: normalizeComplianceSearch,
})

function CompliancePage() {
  usePageTitle("Compliance")
  const { tab } = Route.useSearch()
  const nav = useNavigate()
  // Filters stay in the URL when hopping between tabs.
  const go = (t: ComplianceTab) =>
    nav({
      to: "/compliance",
      search: (prev): ComplianceSearch => ({
        ...normalizeComplianceSearch(prev),
        tab: t,
      }),
    })

  // Overview and Rules read the summary; Violations the full list. Both
  // run the same live evaluation, so neither refetches on focus.
  const summary = useQuery({
    queryKey: ["compliance-summary"],
    queryFn: () => api<ComplianceSummary>("/api/compliance/summary/"),
    refetchOnWindowFocus: false,
  })
  const evaluation = useQuery({
    queryKey: ["compliance-eval"],
    queryFn: () => api<ComplianceEvaluation>("/api/compliance/evaluate/"),
    refetchOnWindowFocus: false,
    enabled: tab === "violations",
  })
  const active = tab === "violations" ? evaluation : summary
  const evaluatedAt = active.data?.evaluated_at
  const open = summary.data?.totals.open

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-muted/30">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-4 py-2 lg:px-6">
        <h1 className="flex shrink-0 items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Compliance
        </h1>
        <SegmentedTabs<ComplianceTab>
          className="ml-2 min-w-[min(100%,16rem)] flex-1"
          wrap
          value={tab}
          onValueChange={go}
          items={[
            { value: "overview", label: "Overview" },
            { value: "violations", label: "Violations", count: open || null },
            {
              value: "rules",
              label: "Rules",
              count: summary.data
                ? summary.data.totals.rules + summary.data.totals.disabled_rules
                : null,
            },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          {evaluatedAt && (
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              Evaluated <TimeCell iso={evaluatedAt} />
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void summary.refetch()
              if (tab === "violations") void evaluation.refetch()
            }}
            disabled={active.isFetching}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {active.isFetching ? "Evaluating…" : "Evaluate now"}
          </Button>
        </div>
      </header>

      {tab === "overview" && (
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          <ComplianceOverview query={summary} />
        </div>
      )}
      {tab === "violations" && (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          <ViolationsTab query={evaluation} />
        </div>
      )}
      {tab === "rules" && (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          <RulesTab summary={summary} />
        </div>
      )}
    </div>
  )
}
