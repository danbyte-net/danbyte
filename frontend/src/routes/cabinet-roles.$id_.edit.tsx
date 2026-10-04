import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { CabinetRole } from "@/lib/api"
import { CabinetRoleForm } from "@/components/cabinet-role-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cabinet-roles/$id_/edit")({
  component: EditCabinetRolePage,
})

function EditCabinetRolePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cabinet-role", id],
    queryFn: () => api<CabinetRole>(`/api/cabinet-roles/${id}/`),
  })
  const back = () => nav({ to: "/cabinet-roles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Cabinet roles", to: "/cabinet-roles" },
        q.data
          ? { label: q.data.name, to: "/cabinet-roles/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit role"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CabinetRoleForm role={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
