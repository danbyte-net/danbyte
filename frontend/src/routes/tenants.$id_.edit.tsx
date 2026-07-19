import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Tenant } from "@/lib/api"
import { TenantForm } from "@/components/tenant-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/tenants/$id_/edit")({
  component: EditTenantPage,
})

function EditTenantPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["tenant", id],
    queryFn: () => api<Tenant>(`/api/tenants/${id}/`),
  })
  const backToDetail = () => nav({ to: "/tenants/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Tenants", to: "/tenants" },
        q.data
          ? { label: q.data.name, to: "/tenants/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit tenant"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <TenantForm
          tenant={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
