import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type IPRole } from "@/lib/api"
import { IpRoleForm } from "@/components/ip-role-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/ip-roles/$id_/edit")({
  component: EditIpRolePage,
})

function EditIpRolePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["ip-role", id],
    queryFn: () => api<IPRole>(`/api/ip-roles/${id}/`),
  })
  const back = () => nav({ to: "/ip-roles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "IP roles", to: "/ip-roles" },
        q.data
          ? { label: q.data.name, to: "/ip-roles/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit role"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <IpRoleForm role={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
