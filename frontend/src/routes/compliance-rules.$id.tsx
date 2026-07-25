import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { BookOpenText, Pencil, RefreshCw, Trash2 } from "lucide-react"

import {
  api,
  type ComplianceRule,
  type ComplianceRuleViolations,
  type ComplianceViolation,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import {
  affectedColumnsFor,
  AFFECTED_FLEX_COLUMN,
} from "@/components/columns/affected-columns"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Markdown } from "@/components/markdown"
import { QueryError } from "@/components/query-error"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { TimeCell } from "@/components/cells/time-ago"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"
import {
  DeleteRule,
  OBJ_ROUTE,
  SEV_VARIANT,
  ruleSummary,
} from "@/routes/compliance"

export const Route = createFileRoute("/compliance-rules/$id")({
  component: RuleDetailPage,
})

function RuleDetailPage() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["compliance-rule", id],
    queryFn: () => api<ComplianceRule>(`/api/compliance-rules/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body rule={q.data} />
}

function Body({ rule: r }: { rule: ComplianceRule }) {
  const nav = useNavigate()
  const { canDo } = useMe()
  const canEdit = canDo("compliancerule", "change")
  const canDelete = canDo("compliancerule", "delete")
  const [deleting, setDeleting] = useState<ComplianceRule | null>(null)
  const [tab, setTab] = useUrlTab<
    "overview" | "affected" | "journal" | "history"
  >("overview")

  return (
    <DetailShell
      backTo="/compliance"
      backLabel="Compliance"
      title={r.name}
      presence={{ type: "compliancerule", id: r.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/compliance-rules/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight">
                {r.name}
              </span>
              <Badge variant={SEV_VARIANT[r.severity]} className="capitalize">
                {r.severity}
              </Badge>
              {!r.enabled && <Badge variant="outline">Disabled</Badge>}
            </div>
            {r.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {r.description}
              </p>
            )}
          </div>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "affected", label: "Affected objects" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RuleOverview rule={r} />
      </DetailTab>
      <DetailTab value="affected">
        {r.remediation && (
          <div className="mb-4 rounded-lg border border-border bg-card px-4 py-3">
            <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
              <BookOpenText className="h-3.5 w-3.5 text-muted-foreground" />
              How to fix
            </h2>
            <Markdown source={r.remediation} />
          </div>
        )}
        <AffectedObjects
          ruleId={r.id}
          ruleName={r.name}
          objectType={r.object_type}
          enabled={r.enabled}
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="compliance.compliancerule" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel
          objectType="compliance.compliancerule"
          objectId={r.id}
        />
      </DetailTab>

      <DeleteRule
        rule={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={() => nav({ to: "/compliance", search: { tab: "rules" } })}
      />
    </DetailShell>
  )
}

/** Rule attributes that used to crowd the header, grouped into tables. Only the
 * name, severity and enabled state stay up top. */
function RuleOverview({ rule: r }: { rule: ComplianceRule }) {
  const rule: KvRow[] = [
    { label: "Applies to", value: r.object_type_label },
    { label: "Enabled", value: r.enabled ? "Yes" : "No" },
    {
      label: "Severity",
      value: (
        <Badge variant={SEV_VARIANT[r.severity]} className="capitalize">
          {r.severity}
        </Badge>
      ),
    },
  ]

  const check: KvRow[] = [
    { label: "Check type", value: r.check_type_display || r.check_type },
    { label: "Condition", value: mono(ruleSummary(r)) },
    { label: "Field", value: mono(r.field) },
    { label: "Pattern", value: mono(r.pattern) },
    { label: "Tag", value: r.tag || dash },
    { label: "Custom field", value: mono(r.cf_key) },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Rule" rows={rule} />
      <KvCard title="Check" rows={check} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}

function AffectedObjects({
  ruleId,
  ruleName,
  objectType,
  enabled,
}: {
  ruleId: string
  ruleName: string
  objectType: string
  enabled: boolean
}) {
  const q = useQuery({
    queryKey: ["compliance-rule-violations", ruleId],
    queryFn: () =>
      api<ComplianceRuleViolations>(
        `/api/compliance-rules/${ruleId}/violations/`
      ),
    refetchOnWindowFocus: false,
  })

  // The genuine per-type table (prefix/IP/device/…) when we have a factory for
  // this object type; otherwise a generic object + type fallback.
  const realColumns = useMemo(
    () => affectedColumnsFor(objectType),
    [objectType]
  )

  const fallbackColumns = useMemo<ColumnDef<ComplianceViolation>[]>(
    () => [
      {
        id: "object",
        accessorKey: "object_repr",
        header: ({ column }) => <SortHeader column={column} label="Object" />,
        cell: ({ row }) => {
          const route = OBJ_ROUTE[row.original.object_type]
          return route ? (
            <Link
              to={route}
              params={{ id: row.original.object_id }}
              className="font-mono font-medium hover:underline"
            >
              {row.original.object_repr}
            </Link>
          ) : (
            <span className="font-mono font-medium">
              {row.original.object_repr}
            </span>
          )
        },
      },
      {
        id: "type",
        accessorKey: "object_type_label",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.object_type_label}
          </span>
        ),
      },
    ],
    []
  )

  const total = q.data?.total ?? 0

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Affected objects
        </h2>
        {q.data && (
          <Badge variant={total > 0 ? "destructive" : "success"}>{total}</Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
          />
          Re-evaluate
        </Button>
      </div>

      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && (
        <p className="text-sm text-muted-foreground">Evaluating…</p>
      )}
      {q.data && total === 0 && (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {enabled
            ? "Nothing fails this rule. 🎉"
            : "This rule is disabled — it isn't evaluated."}
        </div>
      )}
      {q.data && total > 0 && realColumns ? (
        <DataTable
          data={q.data.objects}
          columns={realColumns}
          flexColumn={AFFECTED_FLEX_COLUMN}
          tableId={`compliance-affected-${objectType}`}
          exportName={`affected-${objectType}`}
          exportTitle={ruleName}
        />
      ) : q.data && total > 0 ? (
        <DataTable
          data={q.data.violations}
          columns={fallbackColumns}
          flexColumn="object"
          exportTitle={ruleName}
        />
      ) : null}
    </div>
  )
}
