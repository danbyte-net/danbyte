import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2, X } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  Application,
  ApplicationTreeNode,
  InstalledSoftware,
} from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useUrlText } from "@/lib/use-url-state"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
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
import { FlowRequirementsPane } from "@/components/flow-requirements-pane"
import { ApplicationFlowDiagram } from "@/components/application-flow-diagram"
import { ApplicationGroupsOfApp } from "@/components/application-groups-of-app"
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
    | "requirements"
    | "diagram"
    | "children"
    | "groups"
    | "journal"
    | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Application | null>(null)
  const goBack = useCallback(() => nav({ to: "/applications" }), [nav])
  const { canDo, humanIds } = useMe()
  const [cycle, setCycle] = useUrlText("cycle")

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
    { label: "Slug", value: <span className="font-mono">{app.slug}</span> },
    {
      label: "Installs",
      value:
        app.install_count > 0 ? (
          <Link
            to="/lifecycle"
            search={{ source: "software", application: app.id }}
            className="link num"
          >
            {app.install_count}
          </Link>
        ) : (
          <span className="num">0</span>
        ),
    },
    {
      label: "Flows",
      value: <span className="num">{app.flow_count}</span>,
    },
    ...(canDo("applicationflowrequirement", "view")
      ? [
          {
            label: "Requirements",
            value: <span className="num">{app.requirement_count ?? 0}</span>,
          } satisfies KvRow,
        ]
      : []),
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
          ? [{ value: "flows", label: "Flows", count: app.flow_count }]
          : []),
        ...(canDo("applicationflowrequirement", "view")
          ? [
              {
                value: "requirements",
                label: "Requirements",
                count: app.requirement_count,
              },
            ]
          : []),
        ...(canDo("applicationflow", "view")
          ? [{ value: "diagram", label: "Diagram" }]
          : []),
        {
          value: "children",
          label: "Child applications",
          count: app.child_count,
        },
        { value: "groups", label: "Groups" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="max-w-5xl space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <KvCard title="Application" rows={rows} />
            <HierarchyCard app={app} />
          </div>
          <ApplicationEolCard
            application={app}
            canEdit={canDo("application", "change")}
          />
        </div>
      </DetailTab>
      <DetailTab value="installs">
        <InstalledOn
          applicationId={app.id}
          cycle={cycle}
          onClearCycle={() => setCycle("")}
        />
      </DetailTab>
      <DetailTab value="flows">
        <ApplicationFlowPane scope={{ kind: "application", id: app.id }} />
      </DetailTab>
      <DetailTab value="requirements">
        <FlowRequirementsPane app={app} />
      </DetailTab>
      <DetailTab value="diagram">
        <ApplicationFlowDiagram app={app} />
      </DetailTab>
      <DetailTab value="children">
        <Children applicationId={app.id} />
      </DetailTab>
      <DetailTab value="groups">
        <ApplicationGroupsOfApp applicationId={app.id} />
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

export function InstalledOn({
  applicationId,
  cycle = "",
  onClearCycle,
}: {
  applicationId: string
  /** `?cycle=`: one end-of-life cycle's installs, `none` the unmapped. */
  cycle?: string
  onClearCycle?: () => void
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("installedsoftware", "add")
  const [adding, setAdding] = useState(false)
  const eol = useEolSettings()
  const q = useQuery({
    queryKey: ["installed-software", "application", applicationId, cycle],
    queryFn: () =>
      apiAll<InstalledSoftware>(
        `/api/installed-software/?application=${applicationId}` +
          (cycle ? `&cycle=${encodeURIComponent(cycle)}` : "")
      ),
  })
  const columns = useMemo(
    () =>
      buildInstalledSoftwareColumns<InstalledSoftware>({
        omit: ["application"],
        showCycle: true,
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
      {(canAdd || cycle) && (
        <div className="flex items-center gap-2">
          {cycle && (
            <Badge variant="secondary" className="gap-1">
              {cycle === "none" ? "Unmapped" : `Cycle ${cycle}`}
              {onClearCycle && (
                <button
                  type="button"
                  aria-label="Clear cycle"
                  onClick={onClearCycle}
                  className="-mr-1 rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          )}
          {canAdd && (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState
          title={cycle ? "No installs here." : "Not installed anywhere yet."}
        />
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

/** The application's place in the tree: the ancestors as linked crumbs and
 * the children three levels deep, each with its install count. Nothing when
 * the application stands alone. */
function HierarchyCard({ app }: { app: Application }) {
  const ancestors = app.ancestors ?? []
  const children = app.children ?? []
  if (ancestors.length === 0 && children.length === 0) return null
  const rows: KvRow[] = []
  if (ancestors.length > 0)
    rows.push({
      label: "Path",
      value: (
        <span className="flex flex-wrap items-center gap-x-1">
          {ancestors.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1">
              <Link
                to="/applications/$id"
                params={{ id: a.id }}
                className="link"
              >
                {a.name}
              </Link>
              <span className="text-muted-foreground">›</span>
            </span>
          ))}
          <span className="font-medium">{app.name}</span>
        </span>
      ),
    })
  if (children.length > 0)
    rows.push({ label: "Children", value: <TreeNodes nodes={children} /> })
  return <KvCard title="Hierarchy" rows={rows} />
}

function TreeNodes({
  nodes,
  depth = 0,
}: {
  nodes: ApplicationTreeNode[]
  depth?: number
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((n) => {
        const more = (n.child_count ?? 0) - (n.children?.length ?? 0)
        return (
          <li key={n.id}>
            <div
              className="flex items-center gap-1.5"
              style={{ paddingLeft: depth * 16 }}
            >
              {depth > 0 && (
                <span className="font-mono text-[11px] text-muted-foreground/50">
                  └
                </span>
              )}
              <Link
                to="/applications/$id"
                params={{ id: n.id }}
                className="link"
              >
                {n.name}
              </Link>
              <Badge variant="secondary" className="num">
                {n.install_count}
              </Badge>
              {more > 0 && (
                <Link
                  to="/applications/$id"
                  params={{ id: n.id }}
                  search={{ tab: "children" }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  +{more}
                </Link>
              )}
            </div>
            {n.children && n.children.length > 0 && (
              <TreeNodes nodes={n.children} depth={depth + 1} />
            )}
          </li>
        )
      })}
    </ul>
  )
}
