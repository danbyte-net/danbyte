import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  SlaAgreement,
  SlaCheckGroup,
  SlaExclusion,
  SlaFiguresResponse,
  SlaMember,
  SlaMemberFigure,
  SlaPeriodSummary,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { KvCard, dash } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Section } from "@/components/ui/section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import {
  slaIncidentColumns,
  slaMemberColumns,
} from "@/components/columns/sla-columns"
import { DailyAvailability } from "@/components/monitoring/daily-availability"
import {
  PERIOD_LABEL,
  SlaFigureBadge,
  SlaStateBadge,
  fmtBudget,
  fmtSla,
} from "@/components/monitoring/sla-figure"
import { SlaGroupDialog } from "@/components/monitoring/sla-group-dialog"
import {
  SlaExclusionDialog,
  SlaMemberDialog,
} from "@/components/monitoring/sla-member-dialog"
import { fmtSpan } from "@/components/monitoring/status-strip"

export const Route = createFileRoute("/monitoring_/sla/$id")({
  component: SlaPage,
})

const OBJECT_TYPE = "monitoring.slaagreement"

function SlaPage() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["sla-agreement", id],
    queryFn: () => api<SlaAgreement>(`/api/monitoring/sla-agreements/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading...</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body a={q.data} />
}

type Tab =
  | "overview"
  | "members"
  | "groups"
  | "incidents"
  | "exclusions"
  | "revisions"
  | "history"

function Body({ a }: { a: SlaAgreement }) {
  const [tab, setTab] = useUrlTab<Tab>("overview")
  const [period, setPeriod] = useState("current")
  const { canDo } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const base = `/api/monitoring/sla-agreements/${a.id}`

  const figures = useQuery({
    queryKey: ["sla-figures", a.id, period],
    queryFn: () => api<SlaFiguresResponse>(`${base}/figures/?period=${period}`),
    placeholderData: keepPreviousData,
  })
  const periods = useQuery({
    queryKey: ["sla-periods", a.id],
    queryFn: () => api<SlaPeriodSummary[]>(`${base}/periods/`),
  })
  const groups = useQuery({
    queryKey: ["sla-groups", a.id],
    queryFn: () =>
      api<Paginated<SlaCheckGroup>>(
        `/api/monitoring/sla-check-groups/?agreement=${a.id}&page_size=200`
      ),
  })

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["sla-figures", a.id] })
    qc.invalidateQueries({ queryKey: ["sla-periods", a.id] })
    qc.invalidateQueries({ queryKey: ["sla-agreement", a.id] })
    qc.invalidateQueries({ queryKey: ["sla-members", a.id] })
  }
  const recompute = useMutation({
    mutationFn: () => api(`${base}/recompute/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Figures recomputed")
      refreshAll()
    },
    onError: (e) => apiErrorToast(e),
  })
  const del = useMutation({
    mutationFn: () => api<void>(`${base}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${a.name}`)
      qc.invalidateQueries({ queryKey: ["sla-agreements"] })
      nav({ to: "/monitoring", search: { view: "sla", status: "all" } })
    },
    onError: (e) => apiErrorToast(e),
  })
  // Membership and exclusions change the figure: recompute straight away
  // rather than leave the page stale until the next scheduled run.
  const changed = () => {
    if (a.status === "active") recompute.mutate()
    else refreshAll()
  }

  const f = figures.data?.figures
  const current = a.current?.figures
  const periodTabs = useMemo(() => {
    const keys = new Set<string>()
    const items = [{ value: "current", label: "This period" }]
    for (const p of periods.data ?? []) {
      if (p.state === "open" || p.state === "rolling" || keys.has(p.period_key))
        continue
      keys.add(p.period_key)
      items.push({ value: p.period_key, label: p.period_key })
    }
    return items.slice(0, 7)
  }, [periods.data])

  return (
    <DetailShell
      backTo="/monitoring"
      backSearch={{ view: "sla", status: "all" }}
      backLabel="SLAs"
      title={a.name}
      presence={{ type: "slaagreement", id: a.id }}
      actions={
        <>
          {canDo("slaagreement", "change") && a.status === "active" && (
            <Button
              size="sm"
              variant="outline"
              disabled={recompute.isPending}
              onClick={() => recompute.mutate()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {recompute.isPending ? "Recomputing..." : "Recompute"}
            </Button>
          )}
          {canDo("slaagreement", "change") && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/monitoring/sla/$id/edit" params={{ id: a.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("slaagreement", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={a.name}
          badges={
            a.status !== "active" ? (
              <Badge variant="secondary">
                {a.status === "draft" ? "Draft" : "Archived"}
              </Badge>
            ) : current ? (
              <SlaStateBadge state={current.state} />
            ) : undefined
          }
          subtitle={
            <>
              {(a.customer_detail?.name || a.customer_name) && (
                <span>{a.customer_detail?.name || a.customer_name}</span>
              )}
              <span>
                {fmtSla(Number(a.target_pct))} · {PERIOD_LABEL[a.period]}
              </span>
            </>
          }
          description={a.description}
          statCols={3}
          stats={
            <>
              <DetailStat
                label="This period"
                value={<SlaFigureBadge figures={current} />}
              />
              <DetailStat
                label="Budget left"
                value={
                  current ? (
                    <span className="num">
                      {fmtBudget(current.budget_left_s)}
                    </span>
                  ) : (
                    dash
                  )
                }
              />
              <DetailStat
                label="Members"
                value={<span className="num">{a.member_count}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "members", label: "Members", count: a.member_count },
        { value: "groups", label: "Check groups", count: a.group_count },
        { value: "incidents", label: "Incidents" },
        { value: "exclusions", label: "Exclusions" },
        { value: "revisions", label: "Revisions" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="space-y-6">
          <SegmentedTabs
            value={period}
            onValueChange={setPeriod}
            items={periodTabs}
          />
          {figures.isError && <QueryError error={figures.error} />}
          {figures.data && !figures.data.computed && (
            <EmptyState title="Not computed yet">
              {a.status === "active"
                ? "Figures appear within fifteen minutes, or recompute now."
                : "Only active agreements are computed."}
            </EmptyState>
          )}
          {f && figures.data && (
            <>
              {figures.data.limited && (
                <p className="text-[13px] text-muted-foreground">
                  Limited view: {figures.data.limited.hidden_members} member
                  {figures.data.limited.hidden_members === 1
                    ? " is"
                    : "s are"}{" "}
                  outside what you can see, and not in this figure.
                </p>
              )}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <KvCard
                  title={figures.data.period_key ?? "Period"}
                  rows={[
                    {
                      label: "Availability",
                      value: <SlaFigureBadge figures={f} />,
                    },
                    { label: "Target", value: fmtSla(f.target) },
                    {
                      label: "State",
                      value: <SlaStateBadge state={f.state} />,
                    },
                    {
                      label: "Coverage",
                      value: f.coverage == null ? dash : `${f.coverage}%`,
                    },
                    {
                      label: "Period",
                      value:
                        figures.data.state === "frozen"
                          ? "Frozen"
                          : figures.data.state === "closed"
                            ? "Closed - exclusions still possible"
                            : `${f.elapsed_pct}% elapsed`,
                    },
                    {
                      label: "Computed",
                      value: figures.data.computed_at ? (
                        <TimeCell iso={figures.data.computed_at} />
                      ) : (
                        dash
                      ),
                    },
                  ]}
                />
                <KvCard
                  title="Error budget"
                  rows={[
                    { label: "Allowed", value: fmtBudget(f.budget_s) },
                    {
                      label: "Spent",
                      value: `${fmtBudget(f.down_s)} · ${f.budget_spent_pct}%`,
                    },
                    {
                      label: "Left",
                      value: (
                        <span
                          className={
                            f.budget_left_s < 0 ? "text-destructive" : ""
                          }
                        >
                          {fmtBudget(f.budget_left_s)}
                        </span>
                      ),
                    },
                    {
                      label: "Burn rate",
                      value: f.burn_rate == null ? dash : `${f.burn_rate}x`,
                    },
                    {
                      label: "Incidents",
                      value: <span className="num">{f.incidents}</span>,
                    },
                  ]}
                />
              </div>
              {(figures.data.days?.length ?? 0) > 0 && (
                <Section title="Per day">
                  <DailyAvailability
                    days={(figures.data.days ?? []).map((d) => ({
                      date: d.date,
                      uptime_pct: d.availability,
                      up_s: 0,
                      down_s: d.down_s,
                      incidents: 0,
                    }))}
                  />
                </Section>
              )}
            </>
          )}
        </div>
      </DetailTab>

      <DetailTab value="members">
        <Members
          agreement={a}
          figures={figures.data}
          groups={groups.data?.results ?? []}
          onChanged={changed}
        />
      </DetailTab>

      <DetailTab value="groups">
        <Groups
          agreement={a}
          groups={groups.data?.results ?? []}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["sla-groups", a.id] })
            changed()
          }}
        />
      </DetailTab>

      <DetailTab value="incidents">
        <DataTable
          columns={slaIncidentColumns()}
          data={figures.data?.incidents ?? []}
          tableId="sla-incidents"
          exportName={`sla-incidents-${a.name}`}
          exportTitle="SLA incidents"
          flexColumn="members"
        />
      </DetailTab>

      <DetailTab value="exclusions">
        <Exclusions agreement={a} figures={figures.data} onChanged={changed} />
      </DetailTab>

      <DetailTab value="revisions">
        <Revisions agreementId={a.id} />
      </DetailTab>

      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={a.id} />
      </DetailTab>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${a.name}?`}
        description="Its groups, members and every stored period go with it. Archive it instead to keep the history."
        confirmLabel="Delete"
        pendingLabel="Deleting..."
        destructive
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </DetailShell>
  )
}

function Members({
  agreement: a,
  figures,
  groups,
  onChanged,
}: {
  agreement: SlaAgreement
  figures: SlaFiguresResponse | undefined
  groups: SlaCheckGroup[]
  onChanged: () => void
}) {
  const { canDo } = useMe()
  const [adding, setAdding] = useState(false)
  const members = useQuery({
    queryKey: ["sla-members", a.id],
    queryFn: () =>
      api<Paginated<SlaMember>>(
        `/api/monitoring/sla-members/?agreement=${a.id}&current=1&page_size=500`
      ),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/monitoring/sla-members/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Member removed")
      members.refetch()
      onChanged()
    },
    onError: (e) => apiErrorToast(e),
  })
  const canEdit = canDo("slaagreement", "change")
  const columns = useMemo<ColumnDef<SlaMemberFigure>[]>(() => {
    const cols = slaMemberColumns()
    if (!canEdit) return cols
    return [
      ...cols,
      {
        id: "actions",
        enableSorting: false,
        header: "",
        cell: ({ row }) =>
          row.original.member_id ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${row.original.name}`}
              onClick={() => remove.mutate(row.original.member_id!)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null,
      },
    ]
  }, [canEdit, remove])
  // Members added since the last computation show up once it runs; list
  // them so an add is never invisible.
  const computed = new Set((figures?.members ?? []).map((m) => m.member_id))
  const pending = (members.data?.results ?? []).filter(
    (m) => !m.excluded && !computed.has(m.id)
  )
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => setAdding(true)}
            disabled={groups.length === 0}
          >
            <Plus className="h-3.5 w-3.5" /> Add member
          </Button>
        </div>
      )}
      {groups.length === 0 && (
        <EmptyState title="No check groups yet">
          A member belongs to a check group, which says what is measured. Add
          one under Check groups first.
        </EmptyState>
      )}
      {pending.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          Not in the figure yet:{" "}
          {pending.map((m) => m.object?.name ?? m.object_id).join(", ")}
        </p>
      )}
      <DataTable
        columns={columns}
        data={figures?.members ?? []}
        tableId="sla-members"
        exportName={`sla-members-${a.name}`}
        exportTitle="SLA members"
        flexColumn="name"
      />
      <SlaMemberDialog
        agreementId={a.id}
        groups={groups}
        open={adding}
        onOpenChange={setAdding}
        onAdded={() => {
          members.refetch()
          onChanged()
        }}
      />
    </div>
  )
}

function Groups({
  agreement: a,
  groups,
  onChanged,
}: {
  agreement: SlaAgreement
  groups: SlaCheckGroup[]
  onChanged: () => void
}) {
  const { canDo } = useMe()
  const [editing, setEditing] = useState<SlaCheckGroup | "new" | null>(null)
  const canEdit = canDo("slaagreement", "change")
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" /> New group
          </Button>
        </div>
      )}
      {groups.length === 0 && (
        <EmptyState title="No check groups yet">
          A check group names the checks that count for a class of equipment.
        </EmptyState>
      )}
      {groups.map((g) => (
        <Section
          key={g.id}
          title={g.name}
          count={g.member_count}
          actions={
            canEdit && (
              <Button size="sm" variant="outline" onClick={() => setEditing(g)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )
          }
        >
          <KvCard
            title="Measured"
            rows={[
              {
                label: "Checks",
                value: g.items.length ? (
                  <span className="flex flex-wrap gap-1">
                    {g.items.map((i) => (
                      <Badge
                        key={i.template}
                        variant={i.counts ? "secondary" : "outline"}
                      >
                        {i.template_name}
                        {!i.counts && " · informational"}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "Every check on the address"
                ),
              },
              {
                label: "Addresses",
                value: g.target === "all" ? "Every address" : "Primary address",
              },
              {
                label: "Combine",
                value: g.combine === "all" ? "All must pass" : "Weighted",
              },
              {
                label: "Selector",
                value: g.use_selector ? "Matching devices join" : "Off",
              },
            ]}
          />
        </Section>
      ))}
      <SlaGroupDialog
        agreementId={a.id}
        group={editing && editing !== "new" ? editing : undefined}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={onChanged}
      />
    </div>
  )
}

function Exclusions({
  agreement: a,
  figures,
  onChanged,
}: {
  agreement: SlaAgreement
  figures: SlaFiguresResponse | undefined
  onChanged: () => void
}) {
  const { canDo } = useMe()
  const [adding, setAdding] = useState(false)
  const q = useQuery({
    queryKey: ["sla-exclusions", a.id],
    queryFn: () =>
      api<Paginated<SlaExclusion>>(
        `/api/monitoring/sla-exclusions/?agreement=${a.id}&page_size=200`
      ),
  })
  const del = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/monitoring/sla-exclusions/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Exclusion removed")
      q.refetch()
      onChanged()
    },
    onError: (e) => apiErrorToast(e),
  })
  const canEdit = canDo("slaagreement", "change")
  const names = new Map(
    (figures?.members ?? [])
      .filter((m) => m.member_id)
      .map((m) => [m.member_id!, m.name])
  )
  const columns: ColumnDef<SlaExclusion>[] = [
    {
      id: "from",
      accessorFn: (r) => r.starts_at,
      header: "From",
      cell: ({ row }) => <TimeCell iso={row.original.starts_at} />,
    },
    {
      id: "length",
      accessorFn: (r) => Date.parse(r.ends_at) - Date.parse(r.starts_at),
      header: "Length",
      cell: ({ row }) => (
        <span className="num">
          {fmtSpan(
            Date.parse(row.original.ends_at) -
              Date.parse(row.original.starts_at)
          )}
        </span>
      ),
    },
    {
      id: "member",
      accessorFn: (r) => r.member ?? "",
      header: "Member",
      cell: ({ row }) =>
        row.original.member
          ? (names.get(row.original.member) ?? "Member")
          : "Whole agreement",
    },
    {
      id: "reason",
      accessorFn: (r) => r.reason,
      header: "Reason",
      cell: ({ row }) => row.original.reason,
    },
    {
      id: "by",
      accessorFn: (r) => r.created_by_name ?? "",
      header: "By",
      cell: ({ row }) => row.original.created_by_name ?? dash,
    },
    ...(canEdit
      ? [
          {
            id: "actions",
            enableSorting: false,
            header: "",
            cell: ({ row }) => (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove exclusion"
                onClick={() => del.mutate(row.original.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ),
          } satisfies ColumnDef<SlaExclusion>,
        ]
      : []),
  ]
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Exclude time
          </Button>
        </div>
      )}
      <DataTable
        columns={columns}
        data={q.data?.results ?? []}
        tableId="sla-exclusions"
        exportName={`sla-exclusions-${a.name}`}
        exportTitle="SLA exclusions"
        flexColumn="reason"
      />
      <SlaExclusionDialog
        agreementId={a.id}
        members={[...names].map(([id, name]) => ({ id, name }))}
        open={adding}
        onOpenChange={setAdding}
        onSaved={() => {
          q.refetch()
          onChanged()
        }}
      />
    </div>
  )
}

const RULE_LABEL: Record<string, string> = {
  target_pct: "Target",
  warning_pct: "At risk below",
  period: "Period",
  timezone: "Timezone",
  service_hours: "Service hours",
  holiday_calendar_id: "Holidays",
  count_degraded_as: "Degraded counts as",
  count_stale_as: "Stale counts as",
  count_unknown_as: "Unknown counts as",
  exclude_maintenance: "Exclude maintenance",
  min_outage_seconds: "Ignore outages under",
  aggregation: "Members combine as",
  effective_from: "Counts from",
}

function Revisions({ agreementId }: { agreementId: string }) {
  const q = useQuery({
    queryKey: ["sla-revisions", agreementId],
    queryFn: () =>
      api<
        {
          number: number
          rules: Record<string, unknown>
          created_at: string
          created_by: string | null
        }[]
      >(`/api/monitoring/sla-agreements/${agreementId}/revisions/`),
  })
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading...</p>
  const revs = q.data ?? []
  return (
    <div className="space-y-4">
      {revs.map((r, i) => {
        const prev = i + 1 < revs.length ? revs[i + 1].rules : undefined
        const changed = prev
          ? Object.keys(RULE_LABEL).filter(
              (k) => JSON.stringify(r.rules[k]) !== JSON.stringify(prev[k])
            )
          : []
        return (
          <Section
            key={r.number}
            title={`Revision ${r.number}`}
            description={r.created_by ?? undefined}
            actions={<TimeCell iso={r.created_at} />}
          >
            {prev ? (
              <KvCard
                title="Changed"
                rows={changed.map((k) => ({
                  label: RULE_LABEL[k],
                  value: (
                    <span className="font-mono text-[12px]">
                      {JSON.stringify(prev[k])} → {JSON.stringify(r.rules[k])}
                    </span>
                  ),
                }))}
              />
            ) : (
              <p className="text-[13px] text-muted-foreground">
                The first set of rules.
              </p>
            )}
          </Section>
        )
      })}
    </div>
  )
}
