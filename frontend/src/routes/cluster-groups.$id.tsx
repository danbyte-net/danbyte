import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type ClusterGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { ClusterGroupDeleteDialog } from "@/components/cluster-group-delete-dialog"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { EmbeddedClusterTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cluster-groups/$id")({
  component: ClusterGroupDetail,
})

function ClusterGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cluster-group", id],
    queryFn: () => api<ClusterGroup>(`/api/cluster-groups/${id}/`),
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
  return <Body clusterGroup={q.data} />
}

function Body({ clusterGroup: m }: { clusterGroup: ClusterGroup }) {
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("clustergroup", "change")
  const canDelete = canDo("clustergroup", "delete")
  const [tab, setTab] = useState<"clusters" | "journal" | "history">("clusters")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ClusterGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/cluster-groups" }), [nav])

  return (
    <DetailShell
      backTo="/cluster-groups"
      backLabel="Cluster groups"
      title={m.name}
      presence={{ type: "clustergroup", id: m.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cluster-groups/$id/edit" params={{ id: m.id }}>
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="text-2xl font-semibold tracking-tight">
              {m.name}
            </div>
            <div className="mt-1 font-mono text-[13px] text-muted-foreground">
              {m.slug}
            </div>
            {m.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {m.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-1 gap-y-3 text-[13px]">
            {humanIds && m.numid != null && (
              <div>
                <dt className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Number
                </dt>
                <dd className="mt-0.5">
                  <span className="num font-mono">#{m.numid}</span>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Clusters
              </dt>
              <dd className="mt-0.5">
                <span className="num">{m.cluster_count}</span>
              </dd>
            </div>
          </dl>
        </section>
      }
      tabs={[
        { value: "clusters", label: "Clusters", count: m.cluster_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="clusters">
        <EmbeddedClusterTable filter={{ group: m.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.clustergroup" objectId={m.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.clustergroup" objectId={m.id} />
      </DetailTab>

      <ClusterGroupDeleteDialog
        clusterGroup={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
