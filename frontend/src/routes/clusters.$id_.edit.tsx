import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Cluster } from "@/lib/api"
import { ClusterForm } from "@/components/cluster-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/clusters/$id_/edit")({
  component: EditClusterPage,
})

function EditClusterPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cluster", id],
    queryFn: () => api<Cluster>(`/api/clusters/${id}/`),
  })
  const backToDetail = () => nav({ to: "/clusters/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Clusters", to: "/clusters" },
        q.data
          ? { label: q.data.name, to: "/clusters/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit cluster"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ClusterForm
          cluster={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
