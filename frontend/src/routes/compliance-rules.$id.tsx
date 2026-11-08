import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import {
  BookOpenText,
  ListFilter,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react"

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
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { TimeCell } from "@/components/cells/time-ago"
import { useEolSettings } from "@/components/cells/eol-cell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"
import { ObjectLink, RuleResult } from "@/components/columns/compliance-columns"
import { DeleteRule } from "@/components/compliance/delete-rule-dialog"
import {
  OBJECT_TYPE_LABEL,
  SeverityBadge,
  ruleSummary,
} from "@/components/compliance/compliance-shared"
import { ExpressionView } from "@/components/compliance/expression-view"
import { useComplianceFields } from "@/components/compliance/rule-form"
import { SegmentedTabs } from "@/components/segmented-tabs"

export const Route = createFileRoute("/compliance-rules/$id")({
  component: RuleDetailPage,
})

// The list endpoint whose rows each object type's affected table shows.
const AFFECTED_LIST_API: Record<string, string> = {
  prefix: "/api/prefixes/",
  ipaddress: "/api/ips/",
  device: "/api/devices/",
  vlan: "/api/vlans/",
  vrf: "/api/vrfs/",
  site: "/api/sites/",
  virtualmachine: "/api/virtual-machines/",
}

function RuleDetailPage() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["compliance-rule", id],
    queryFn: () => api<ComplianceRule>(`/api/compliance-rules/${id}/`),
  })
  if (q.isLoading) return <Loading />
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
  const [rawTab, setTab] = useUrlTab<
    "overview" | "results" | "affected" | "journal" | "history"
  >("overview")
  // `affected` was the Results tab's old name; old links still land on it.
  const tab = rawTab === "affected" ? "results" : rawTab
  // Fetched up front so the Results tab wears its count; the panel
  // reads the same query rather than running the engine a second time.
  const violations = useRuleViolations(r.id)

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
        <DetailHero
          title={r.name}
          badges={
            <>
              <SeverityBadge severity={r.severity} />
              {violations.data ? (
                <RuleResult
                  rule={violations.data.result ?? undefined}
                  enabled={r.enabled}
                />
              ) : (
                !r.enabled && <Badge variant="outline">Disabled</Badge>
              )}
            </>
          }
          subtitle={
            <span className="text-xs text-muted-foreground">
              {r.object_type_label} · {ruleSummary(r)}
              {violations.data?.evaluated_at && (
                <>
                  {" "}
                  · evaluated <TimeCell iso={violations.data.evaluated_at} />
                </>
              )}
            </span>
          }
          description={r.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "results",
          label: "Results",
          count: violations.data?.total,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RuleOverview rule={r} error={violations.data?.result?.error} />
      </DetailTab>
      <DetailTab value="results">
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
          violations={violations}
          ruleId={r.id}
          ruleName={r.name}
          objectTypes={r.object_types.length ? r.object_types : [r.object_type]}
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
function RuleOverview({
  rule: r,
  error,
}: {
  rule: ComplianceRule
  error?: string | null
}) {
  const types = r.object_types.length ? r.object_types : [r.object_type]
  const fields = useComplianceFields(types).data?.fields ?? []
  const rule: KvRow[] = [
    { label: "Enabled", value: r.enabled ? "Yes" : "No" },
    {
      label: "Severity",
      value: <SeverityBadge severity={r.severity} />,
    },
    ...(error
      ? [
          {
            label: "Broken",
            value: <span className="text-destructive">{error}</span>,
          },
        ]
      : []),
  ]

  const appliesTo: KvRow[] = [
    {
      label: "Object types",
      value: types.map((t) => OBJECT_TYPE_LABEL[t] ?? t).join(", "),
    },
    {
      label: "Scope",
      value: (
        <ExpressionView
          expr={r.scope}
          refs={r.refs}
          fields={fields}
          empty="Every object"
        />
      ),
    },
  ]

  const check: KvRow[] =
    r.check_type === "expression"
      ? [
          { label: "Check type", value: r.check_type_display || r.check_type },
          {
            label: "Must match",
            value: (
              <ExpressionView
                expr={r.condition}
                refs={r.refs}
                fields={fields}
              />
            ),
          },
        ]
      : [
          { label: "Check type", value: r.check_type_display || r.check_type },
          {
            label: "Condition",
            value: mono(ruleSummary({ ...r, scope: null })),
          },
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
      <KvCard title="Applies to" rows={appliesTo} />
      <KvCard title="Check" rows={check} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}

/** Live evaluation of the rule against its tenant - {violations, objects,
 * total}. Owned by the detail page so the tab and the panel share one run. */
function useRuleViolations(ruleId: string) {
  return useQuery({
    queryKey: ["compliance-rule-violations", ruleId],
    queryFn: () =>
      api<ComplianceRuleViolations>(
        `/api/compliance-rules/${ruleId}/violations/`
      ),
    refetchOnWindowFocus: false,
  })
}

function AffectedObjects({
  violations: q,
  ruleId,
  ruleName,
  objectTypes,
  enabled,
}: {
  violations: ReturnType<typeof useRuleViolations>
  ruleId: string
  ruleName: string
  objectTypes: string[]
  enabled: boolean
}) {
  // One table per object type, picked by segmented tabs on a rule of
  // several; each wears its own type's columns.
  const [picked, setPicked] = useState(objectTypes[0])
  const objectType = objectTypes.includes(picked) ? picked : objectTypes[0]
  const byType = q.data?.result?.by_type
  // The genuine per-type table (prefix/IP/device/…) when we have a factory for
  // this object type; otherwise a generic object + type fallback.
  const { enabled: eolOn } = useEolSettings()
  const realColumns = useMemo(
    () => affectedColumnsFor(objectType, eolOn),
    [objectType, eolOn]
  )

  const fallbackColumns = useMemo<ColumnDef<ComplianceViolation>[]>(
    () => [
      {
        id: "object",
        accessorKey: "object_repr",
        header: ({ column }) => <SortHeader column={column} label="Object" />,
        cell: ({ row }) => (
          <ObjectLink
            objectType={row.original.object_type}
            id={row.original.object_id}
            label={row.original.object_repr}
          />
        ),
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
          Violating objects
        </h2>
        {q.data && (
          <Badge variant={total > 0 ? "destructive" : "success"}>{total}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {total > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link
                to="/compliance"
                search={{ tab: "violations", rule: ruleId }}
              >
                <ListFilter className="h-3.5 w-3.5" />
                Triage
              </Link>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {q.isFetching ? "Evaluating…" : "Re-evaluate"}
          </Button>
        </div>
      </div>

      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <Loading />}
      {q.data && total === 0 && (
        <EmptyState
          title={
            enabled ? "Nothing fails this rule." : "This rule is disabled."
          }
        />
      )}
      {q.data && total > 0 && objectTypes.length > 1 && (
        <SegmentedTabs
          className="mb-3"
          items={objectTypes.map((t) => ({
            value: t,
            label: OBJECT_TYPE_LABEL[t] ?? t,
            count: byType?.[t] ?? null,
          }))}
          value={objectType}
          onValueChange={setPicked}
        />
      )}
      {q.data && total > 0 && realColumns ? (
        <DataTable
          key={objectType}
          data={q.data.objects_by_type?.[objectType] ?? q.data.objects}
          columns={realColumns}
          flexColumn={AFFECTED_FLEX_COLUMN}
          tableId={`compliance-affected-${objectType}`}
          // The rows are the type's own list rows (served from its list
          // queryset, cut to what you may view), so its catalog applies.
          autoColumns={{ api: AFFECTED_LIST_API[objectType] ?? null }}
          exportName={`affected-${objectType}`}
          exportTitle={ruleName}
          searchable
          searchPlaceholder="Search objects…"
        />
      ) : q.data && total > 0 ? (
        <DataTable
          data={q.data.violations.filter((v) => v.object_type === objectType)}
          columns={fallbackColumns}
          flexColumn="object"
          exportTitle={ruleName}
          searchable
          searchPlaceholder="Search objects…"
        />
      ) : null}
    </div>
  )
}
