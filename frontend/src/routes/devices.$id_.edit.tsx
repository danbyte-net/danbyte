import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Device } from "@/lib/api"
import { DeviceForm } from "@/components/device-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/devices/$id_/edit")({
  component: EditDevicePage,
})

function EditDevicePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["device", id],
    queryFn: () => api<Device>(`/api/devices/${id}/`),
  })
  const back = () => nav({ to: "/devices/$id", params: { id } })
  return (
    <EditPageShell
      presenceType="device"
      presenceId={id}
      crumbs={[
        { label: "Devices", to: "/devices" },
        q.data
          ? { label: q.data.name, to: "/devices/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit device"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <DeviceForm device={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
