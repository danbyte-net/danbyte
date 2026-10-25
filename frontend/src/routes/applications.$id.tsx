import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { Application, InstalledSoftware } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { Loading } from "@/components/loading"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ApplicationEolCard } from "@/components/eol-card"
import { ApplicationDeleteDialog } from "@/components/application-delete-dialog"
import { useEolSettings } from "@/components/cells/eol-cell"
import { dash } from "@/components/cells/dash"
import { buildApplicationColumns } from "@/components/columns/application-columns"
import { buildInstalledSoftwareColumns } from "@/components/columns/installed-software-columns"
import { ApplicationFlowPane } from "@/components/application-flow-pane"
import { ApplicationFlowDiagram } from "@/components/application-flow-diagram"
import { InstalledSoftwareDialog } from "@/components/installed-software-pane"

export const Route = createFileRoute("/applications/$id")({
  component: ApplicationDetail,
})

function ApplicationDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["application", id],
    queryFn: () => api<Application>(`/api/applications/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body app={q.data} />
}

function Body({ app }: { app: Application }) {
  const [tab, setTab] = useUrlTab<
    | "overview"
    | "installs"
    | "flows"
    | "diagram"
    | "children"
    | "journal"
    | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Application | null>(null)
  const goBack = useCallback(() => nav({ to: "/applications" }), [nav])
  const { canDo, humanIds } = useMe()

  const rows: KvRow[] = [
    ...(humanIds && app.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{app.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Parent",
      value: app.parent ? (
        <Link
          to="/applications/$id"
          params={{ id: app.parent.id }}
          className="link"
        >
          {app.parent.name}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Path", value: app.path },
    { label: "Slug", value: <span className="font-mono">{app.slug}</span> },
    {
      label: "Installs",
      value: <span className="num">{app.install_count}</span>,
    },
    {
      label: "Flows",
      value: <span className="num">{app.flow_count}</span>,
    },
  ]

  return (
    <DetailShell
      backTo="/applications"
      backLabel="Applications"
      title={app.name}
      presence={{ type: "application", id: app.id }}
      actions={
        <>
          {canDo("application", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/applications/$id/edit" params={{ id: app.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("application", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(app)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={app.name}
          subtitle={
            app.manufacturer && (
              <Link
                to="/manufacturers/$id"
                params={{ id: app.manufacturer.id }}
                className="link"
              >
                {app.manufacturer.name}
              </Link>
            )
          }
          description={app.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "installs", label: "Installed on", count: app.install_count },
        ...(canDo("applicationflow", "view")
          ? [
              { value: "flows", label: "Flows", count: app.flow_count },
              { value: "diagram", label: "Diagram" },
            ]
          : []),
        {
          value: "children",
          label: "Child applications",
          count: app.child_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="max-w-xl space-y-6">
          <KvCard title="Application" rows={rows} />
          <ApplicationEolCard
            application={app}
            canEdit={canDo("application", "change")}
          />
        </div>
      </DetailTab>
      <DetailTab value="installs">
        <InstalledOn applicationId={app.id} />
      </DetailTab>
      <DetailTab value="flows">
        <ApplicationFlowPane scope={{ kind: "application", id: app.id }} />
      </DetailTab>
      <DetailTab value="diagram">
        <ApplicationFlowDiagram app={app} />
      </DetailTab>
      <DetailTab value="children">
        <Children applicationId={app.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.application" objectId={app.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.application" objectId={app.id} />
      </DetailTab>
      <ApplicationDeleteDialog
        application={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

export function InstalledOn({ applicationId }: { applicationId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("installedsoftware", "add")
  const [adding, setAdding] = useState(false)
  const eol = useEolSettings()
  const q = useQuery({
    queryKey: ["installed-software", "application", applicationId],
    queryFn: () =>
      apiAll<InstalledSoftware>(
        `/api/installed-software/?application=${applicationId}`
      ),
  })
  const columns = useMemo(
    () =>
      buildInstalledSoftwareColumns<InstalledSoftware>({
        omit: ["application"],
        eol: eol.enabled,
        warningDays: eol.data?.warning_days,
      }),
    [eol.enabled, eol.data?.warning_days]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Not installed anywhere yet." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="application-installs"
          embedded
          searchable
          searchPlaceholder="Search installs…"
        />
      )}
      <InstalledSoftwareDialog
        application={{ id: applicationId }}
        install={null}
        open={adding}
        onOpenChange={setAdding}
        onSaved={() => {
          // Covers ["installed-software", "application", id] and the
          // device/VM Software tabs.
          qc.invalidateQueries({ queryKey: ["installed-software"] })
          qc.invalidateQueries({ queryKey: ["application", applicationId] })
          qc.invalidateQueries({ queryKey: ["lifecycle"] })
          setAdding(false)
        }}
      />
    </div>
  )
}

function Children({ applicationId }: { applicationId: string }) {
  const { humanIds } = useMe()
  const q = useQuery({
    queryKey: ["applications", "children", applicationId],
    queryFn: () =>
      apiAll<Application>(`/api/applications/?parent=${applicationId}`),
  })
  const columns = useMemo(
    () => buildApplicationColumns<Application>({ humanIds }),
    [humanIds]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) return <EmptyState title="No child applications." />
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      tableId="application-children"
      embedded
    />
  )
}
