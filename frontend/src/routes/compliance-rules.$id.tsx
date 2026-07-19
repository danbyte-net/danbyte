import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, RefreshCw, Trash2 } from "lucide-react"

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
import { QueryError } from "@/components/query-error"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
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
  const [tab, setTab] = useState<"affected" | "journal" | "history">("affected")

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
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] sm:grid-cols-3">
            <DetailStat label="Applies to" value={r.object_type_label} />
            <DetailStat
              label="Check"
              value={
                <span className="font-mono text-xs">{ruleSummary(r)}</span>
              }
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "affected", label: "Affected objects" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="affected">
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
