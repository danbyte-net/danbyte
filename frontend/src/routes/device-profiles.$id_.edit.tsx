import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceProfile } from "@/lib/api"
import { DeviceProfileForm } from "@/components/device-profile-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/device-profiles/$id_/edit")({
  component: EditDeviceProfilePage,
})

function EditDeviceProfilePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["device-profile", id],
    queryFn: () => api<DeviceProfile>(`/api/device-profiles/${id}/`),
  })
  const back = () => nav({ to: "/device-profiles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Device profiles", to: "/device-profiles" },
        q.data
          ? {
              label: q.data.name,
              to: "/device-profiles/$id",
              params: { id },
            }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit device profile"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <DeviceProfileForm profile={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
