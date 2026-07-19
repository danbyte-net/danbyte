import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type DeviceType } from "@/lib/api"
import { DeviceTypeForm } from "@/components/device-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/device-types/$id_/edit")({
  component: EditDeviceTypePage,
})

function EditDeviceTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["device-type", id],
    queryFn: () => api<DeviceType>(`/api/device-types/${id}/`),
  })
  const back = () => nav({ to: "/device-types/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Device types", to: "/device-types" },
        q.data
          ? { label: q.data.name, to: "/device-types/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit device type"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <DeviceTypeForm deviceType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
