import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type DeviceRole } from "@/lib/api"
import { DeviceRoleForm } from "@/components/device-role-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/device-roles/$id_/edit")({
  component: EditDeviceRolePage,
})

function EditDeviceRolePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["device-role", id],
    queryFn: () => api<DeviceRole>(`/api/device-roles/${id}/`),
  })
  const back = () => nav({ to: "/device-roles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Device roles", to: "/device-roles" },
        q.data
          ? { label: q.data.name, to: "/device-roles/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit role"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <DeviceRoleForm role={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
