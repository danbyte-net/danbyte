import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type ObjectPermission } from "@/lib/api"
import { PermissionForm } from "@/components/permission-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/permissions/$id_/edit")({
  component: EditPermissionPage,
})

function EditPermissionPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["object-permission", id],
    queryFn: () => api<ObjectPermission>(`/api/object-permissions/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Permissions", to: "/permissions" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit permission"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PermissionForm
          permission={q.data}
          onSaved={() => nav({ to: "/permissions" })}
          onCancel={() => nav({ to: "/permissions" })}
        />
      )}
    </EditPageShell>
  )
}
