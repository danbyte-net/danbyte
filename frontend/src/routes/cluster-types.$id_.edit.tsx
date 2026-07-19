import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ClusterType } from "@/lib/api"
import { ClusterTypeForm } from "@/components/cluster-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cluster-types/$id_/edit")({
  component: EditClusterTypePage,
})

function EditClusterTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cluster-type", id],
    queryFn: () => api<ClusterType>(`/api/cluster-types/${id}/`),
  })
  const back = () => nav({ to: "/cluster-types/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Cluster types", to: "/cluster-types" },
        q.data
          ? { label: q.data.name, to: "/cluster-types/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit cluster type"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ClusterTypeForm clusterType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
