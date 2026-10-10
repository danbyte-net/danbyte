import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { SlaTemplate, SlaTemplateAgreement } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { KvCard, dash } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { DataTable } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { PERIOD_LABEL, fmtSla } from "@/components/monitoring/sla-figure"
import {
  TEMPLATES_URL,
  TemplateSyncBadge,
} from "@/components/monitoring/sla-templates"

export const Route = createFileRoute("/monitoring_/sla/templates/$id")({
  component: SlaTemplatePage,
})

const OBJECT_TYPE = "monitoring.slatemplate"

function SlaTemplatePage() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["sla-template", id],
    queryFn: () => api<SlaTemplate>(`${TEMPLATES_URL}${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body t={q.data} />
}

type Tab = "overview" | "agreements" | "history"

const COUNT_LABEL = { up: "Up", down: "Down", unmeasured: "Not measured" }
const AGGREGATION_LABEL = {
  mean: "Average",
  worst: "Worst member",
  all: "All must be up",
}

function hoursText(h: SlaTemplate["service_hours"]): string {
  const days = Object.entries(h)
  if (!days.length) return "Around the clock"
  return days
    .map(([d, spans]) => `${d} ${spans.map((s) => s.join("-")).join(", ")}`)
    .join(" · ")
}

function Body({ t }: { t: SlaTemplate }) {
  const [tab, setTab] = useUrlTab<Tab>("overview")
  const { canDo } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const base = `${TEMPLATES_URL}${t.id}`
  const linked = useQuery({
    queryKey: ["sla-template-agreements", t.id],
    queryFn: () => api<SlaTemplateAgreement[]>(`${base}/agreements/`),
  })
  const sync = useMutation({
    mutationFn: (ids?: string[]) =>
      api<{ synced: number; unchanged: number }>(`${base}/sync/`, {
        method: "POST",
        body: JSON.stringify(ids ? { agreements: ids } : {}),
      }),
    onSuccess: (r) => {
      toast.success(
        r.synced
          ? `Synced ${r.synced} agreement${r.synced === 1 ? "" : "s"}`
          : "Already in sync"
      )
      qc.invalidateQueries({ queryKey: ["sla-template-agreements", t.id] })
      qc.invalidateQueries({ queryKey: ["sla-agreement"] })
      qc.invalidateQueries({ queryKey: ["sla-agreements"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const del = useMutation({
    mutationFn: () => api<void>(`${base}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${t.name}`)
      qc.invalidateQueries({ queryKey: ["sla-templates"] })
      nav({ to: "/monitoring", search: { view: "sla", status: "all" } })
    },
    onError: (e) => apiErrorToast(e),
  })
  const outOfSync = (linked.data ?? []).filter((a) => a.differs.length > 0)
  const canSync = canDo("slaagreement", "change")
  const columns = useMemo<ColumnDef<SlaTemplateAgreement>[]>(
    () => [
      {
        id: "name",
        accessorFn: (r) => r.name,
        header: "Agreement",
        cell: ({ row }) => (
          <Link
            to="/monitoring/sla/$id"
            params={{ id: row.original.id }}
            className="link"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "status",
        accessorFn: (r) => r.status,
        header: "Status",
        cell: ({ row }) =>
          row.original.status === "active" ? (
            <Badge variant="success">Active</Badge>
          ) : (
            <Badge variant="secondary">
              {row.original.status === "draft" ? "Draft" : "Archived"}
            </Badge>
          ),
      },
      {
        id: "revision",
        accessorFn: (r) => r.revision,
        header: "Revision",
        cell: ({ row }) => <span className="num">{row.original.revision}</span>,
      },
      {
        id: "sync",
        accessorFn: (r) => r.differs.length,
        header: "Template",
        cell: ({ row }) => <TemplateSyncBadge differs={row.original.differs} />,
      },
      ...(canSync
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: "",
              cell: ({ row }) =>
                row.original.differs.length ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Sync ${row.original.name}`}
                    disabled={sync.isPending}
                    onClick={() => sync.mutate([row.original.id])}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                ) : null,
            } satisfies ColumnDef<SlaTemplateAgreement>,
          ]
        : []),
    ],
    [canSync, sync]
  )

  return (
    <DetailShell
      backTo="/monitoring"
      backSearch={{ view: "sla", status: "all" }}
      backLabel="SLAs"
      title={t.name}
      presence={{ type: "slatemplate", id: t.id }}
      actions={
        <>
          {canDo("slatemplate", "change") && (
            <Button size="sm" variant="outline" asChild>
              <Link
                to="/monitoring/sla/templates/$id/edit"
                params={{ id: t.id }}
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("slatemplate", "delete") && (
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
          title={t.name}
          badges={<Badge variant="secondary">Template</Badge>}
          subtitle={
            <span>
              {fmtSla(Number(t.target_pct))} · {PERIOD_LABEL[t.period]}
            </span>
          }
          description={t.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "agreements", label: "Agreements", count: t.agreement_count },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 xl:grid-cols-2">
          <KvCard
            title="Target"
            rows={[
              { label: "Target", value: fmtSla(Number(t.target_pct)) },
              {
                label: "At risk below",
                value: t.warning_pct ? fmtSla(Number(t.warning_pct)) : dash,
              },
              { label: "Period", value: PERIOD_LABEL[t.period] },
              { label: "Timezone", value: t.timezone || "The tenant's" },
            ]}
          />
          <KvCard
            title="Hours and counting"
            rows={[
              { label: "Service hours", value: hoursText(t.service_hours) },
              {
                label: "Holidays",
                value: t.holiday_calendar_detail?.name ?? dash,
              },
              {
                label: "Degraded counts as",
                value: COUNT_LABEL[t.count_degraded_as],
              },
              {
                label: "Stale counts as",
                value: COUNT_LABEL[t.count_stale_as],
              },
              {
                label: "Unknown counts as",
                value: COUNT_LABEL[t.count_unknown_as],
              },
              {
                label: "Planned maintenance",
                value: t.exclude_maintenance ? "Excluded" : "Counted",
              },
              {
                label: "Ignore outages under",
                value: `${t.min_outage_seconds} s`,
              },
              {
                label: "Members combine as",
                value: AGGREGATION_LABEL[t.aggregation],
              },
            ]}
          />
          <KvCard
            title="Latency objectives"
            rows={[
              {
                label: "Objectives",
                value: t.objectives.length
                  ? t.objectives
                      .map(
                        (o) =>
                          `${o.target_pct}% ${o.kind.toUpperCase()} within ${o.threshold_ms} ms`
                      )
                      .join(" · ")
                  : dash,
              },
              {
                label: "Count in the state",
                value: t.objectives_in_state ? "Yes" : "No",
              },
            ]}
          />
          {t.credit_tiers !== undefined && (
            <KvCard
              title="Service credits"
              rows={[
                {
                  label: "Tiers",
                  value: t.credit_tiers.length
                    ? t.credit_tiers
                        .map((c) => `below ${c.below}% → ${c.credit_pct}%`)
                        .join(" · ")
                    : dash,
                },
                {
                  label: "Fee per period",
                  value: t.period_fee ? (
                    <span className="num">
                      {Number(t.period_fee).toLocaleString()} {t.currency}
                    </span>
                  ) : (
                    dash
                  ),
                },
              ]}
            />
          )}
        </div>
      </DetailTab>

      <DetailTab value="agreements">
        <div className="space-y-4">
          {canSync && outOfSync.length > 0 && (
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={sync.isPending}
                onClick={() => sync.mutate(undefined)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {sync.isPending ? "Syncing…" : `Sync ${outOfSync.length}`}
              </Button>
            </div>
          )}
          {linked.isError && <QueryError error={linked.error} />}
          <DataTable
            columns={columns}
            data={linked.data ?? []}
            tableId="sla-template-agreements"
            exportName={`sla-template-${t.name}`}
            exportTitle="SLA template agreements"
            flexColumn="name"
          />
        </div>
      </DetailTab>

      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={t.id} />
      </DetailTab>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${t.name}?`}
        description="Agreements made from it keep their rules and lose the link."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </DetailShell>
  )
}
