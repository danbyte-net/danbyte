import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ClusterGroup } from "@/lib/api"
import { ClusterGroupForm } from "@/components/cluster-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cluster-groups/$id_/edit")({
  component: EditClusterGroupPage,
})

function EditClusterGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cluster-group", id],
    queryFn: () => api<ClusterGroup>(`/api/cluster-groups/${id}/`),
  })
  const back = () => nav({ to: "/cluster-groups/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Cluster groups", to: "/cluster-groups" },
        q.data
          ? { label: q.data.name, to: "/cluster-groups/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit cluster group"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ClusterGroupForm
          clusterGroup={q.data}
          onSaved={back}
          onCancel={back}
        />
      )}
    </EditPageShell>
  )
}
