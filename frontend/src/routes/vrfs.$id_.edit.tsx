import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type VRF } from "@/lib/api"
import { VrfForm } from "@/components/vrf-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/vrfs/$id_/edit")({
  component: EditVrfPage,
})

function EditVrfPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["vrf", id],
    queryFn: () => api<VRF>(`/api/vrfs/${id}/`),
  })
  const backToDetail = () => nav({ to: "/vrfs/$id", params: { id } })

  return (
    <EditPageShell
      presenceType="vrf"
      presenceId={id}
      crumbs={[
        { label: "VRFs", to: "/vrfs" },
        q.data
          ? { label: q.data.name, to: "/vrfs/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit VRF"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <VrfForm vrf={q.data} onSaved={backToDetail} onCancel={backToDetail} />
      )}
    </EditPageShell>
  )
}
