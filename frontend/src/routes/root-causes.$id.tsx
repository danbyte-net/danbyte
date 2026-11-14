import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { api } from "@/lib/api"
import type { MonitoringAlert, RootCauseDetail } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { buildAlertColumns } from "@/components/columns/alert-columns"
import {
  RootCauseAckButton,
  RootCauseStatusBadge,
  rootCauseDuration,
} from "@/components/columns/root-cause-columns"

export const Route = createFileRoute("/root-causes/$id")({
  component: RootCausePage,
})

type Tab = "overview" | "explained"

/** One root cause (#450): the down device, its own alerts, and the alerts
 * it explains. */
function RootCausePage() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["root-cause", id],
    queryFn: () => api<RootCauseDetail>(`/api/monitoring/root-causes/${id}/`),
    refetchInterval: 30_000,
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body data={q.data} />
}

function Body({ data }: { data: RootCauseDetail }) {
  const [tab, setTab] = useUrlTab<Tab>("overview")
  const r = data.incident
  const total = r.explained_count + r.already_alerted_count
  return (
    <DetailShell
      backTo="/alerts"
      backSearch={{
        tab: "root-causes",
        state: "firing",
        severity: "all",
        ack: "all",
        q: "",
        site: "all",
        ...(r.status === "resolved" ? { rc: "resolved" } : {}),
      }}
      backLabel="Root causes"
      title={r.device.name}
      actions={r.status !== "resolved" && <RootCauseAckButton r={r} labeled />}
      hero={
        <DetailHero
          title={r.device.name}
          badges={<RootCauseStatusBadge status={r.status} />}
          subtitle={
            <Link
              to="/devices/$id"
              params={{ id: r.device.id }}
              className="link"
            >
              Open device
            </Link>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "explained", label: "Explained", count: data.alerts.length },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <KvCard title="Root cause" rows={overviewRows(data, total)} />
          </div>
          <section>
            <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
              Root alerts
            </h2>
            <AlertTable rows={data.root_alerts} id="root-cause-root-alerts" />
          </section>
        </div>
      </DetailTab>
      <DetailTab value="explained">
        <AlertTable rows={data.alerts} id="root-cause-explained" />
      </DetailTab>
    </DetailShell>
  )
}

function overviewRows(data: RootCauseDetail, total: number): KvRow[] {
  const r = data.incident
  const d = r.detail
  const rows: KvRow[] = [
    {
      label: "Root",
      value: (
        <Link to="/devices/$id" params={{ id: r.device.id }} className="link">
          {r.device.name}
        </Link>
      ),
    },
    { label: "Status", value: <RootCauseStatusBadge status={r.status} /> },
    { label: "Opened", value: <TimeCell iso={r.opened_at} /> },
    {
      label: "Duration",
      value: <span className="num">{rootCauseDuration(r)}</span>,
    },
    { label: "Explained", value: <span className="num">{total}</span> },
    {
      label: "Already alerted",
      value: <span className="num">{r.already_alerted_count}</span>,
    },
    {
      label: "Reduced redundancy",
      value: <span className="num">{r.reduced_count}</span>,
    },
    {
      label: "Announced",
      value: r.announced_at ? (
        <TimeCell iso={r.announced_at} />
      ) : d.silenced ? (
        "Silenced"
      ) : (
        dash
      ),
    },
  ]
  if (r.resolved_at)
    rows.push(
      { label: "Resolved", value: <TimeCell iso={r.resolved_at} /> },
      {
        label: "Recovered",
        value:
          d.total !== undefined ? (
            <span className="num">
              {d.recovered ?? 0} of {d.total}
            </span>
          ) : (
            dash
          ),
      }
    )
  if (r.merged_into)
    rows.push({
      label: "Merged into",
      value: (
        <Link
          to="/root-causes/$id"
          params={{ id: r.merged_into.id }}
          className="link"
        >
          {r.merged_into.device.name}
        </Link>
      ),
    })
  if (r.acknowledged)
    rows.push({
      label: "Acknowledged",
      value: r.acknowledged_by_name ?? "Yes",
    })
  return rows
}

function AlertTable({ rows, id }: { rows: MonitoringAlert[]; id: string }) {
  const columns = useMemo(() => buildAlertColumns(), [])
  if (rows.length === 0) return <EmptyState title="No alerts." />
  return (
    <DataTable
      tableId={id}
      data={rows}
      columns={columns}
      flexColumn="check"
      embedded
    />
  )
}
