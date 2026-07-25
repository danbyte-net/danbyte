import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type ClusterType } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { ClusterTypeDeleteDialog } from "@/components/cluster-type-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { EmbeddedClusterTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cluster-types/$id")({
  component: ClusterTypeDetail,
})

function ClusterTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cluster-type", id],
    queryFn: () => api<ClusterType>(`/api/cluster-types/${id}/`),
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
  return <Body clusterType={q.data} />
}

function Body({ clusterType: m }: { clusterType: ClusterType }) {
  const { canDo } = useMe()
  const canEdit = canDo("clustertype", "change")
  const canDelete = canDo("clustertype", "delete")
  const [tab, setTab] = useUrlTab<
    "overview" | "clusters" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ClusterType | null>(null)
  const goBack = useCallback(() => nav({ to: "/cluster-types" }), [nav])

  return (
    <DetailShell
      backTo="/cluster-types"
      backLabel="Cluster types"
      title={m.name}
      presence={{ type: "clustertype", id: m.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cluster-types/$id/edit" params={{ id: m.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(m)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={m.name}
          description={m.description}
          statCols={1}
          stats={
            <DetailStat
              label="Clusters"
              value={<span className="num">{m.cluster_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "clusters", label: "Clusters", count: m.cluster_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <ClusterTypeOverview clusterType={m} />
      </DetailTab>
      <DetailTab value="clusters">
        <EmbeddedClusterTable filter={{ type: m.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.clustertype" objectId={m.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.clustertype" objectId={m.id} />
      </DetailTab>

      <ClusterTypeDeleteDialog
        clusterType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Cluster-type attributes, moved out of the page header. */
function ClusterTypeOverview({ clusterType: m }: { clusterType: ClusterType }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && m.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{m.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{m.slug}</span>,
      copy: m.slug,
    },
    { label: "Created", value: <TimeCell iso={m.created_at} /> },
    { label: "Updated", value: <TimeCell iso={m.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Cluster type" rows={details} />
    </div>
  )
}
