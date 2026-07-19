import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type RackRole } from "@/lib/api"
import { RackRoleForm } from "@/components/rack-role-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/rack-roles/$id_/edit")({
  component: EditRackRolePage,
})

function EditRackRolePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["rack-role", id],
    queryFn: () => api<RackRole>(`/api/rack-roles/${id}/`),
  })
  const back = () => nav({ to: "/rack-roles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Rack roles", to: "/rack-roles" },
        q.data
          ? { label: q.data.name, to: "/rack-roles/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit role"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <RackRoleForm role={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
