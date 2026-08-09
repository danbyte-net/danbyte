import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Device } from "@/lib/api"
import { DeviceForm } from "@/components/device-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { PlanModeBanner } from "@/components/planning/plan-mode-banner"
import { PendingChangesNotice } from "@/components/planning/pending-changes-notice"
import { planSearch } from "@/lib/save-object"

export const Route = createFileRoute("/devices/$id_/edit")({
  // Plan mode: ?plan=<taskId>&planBoard=<boardId> turns this form into
  // "record what changed on that task" instead of writing.
  validateSearch: (s: Record<string, unknown>) => planSearch(s),
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
      <PlanModeBanner />
      <PendingChangesNotice objectType="api.device" objectId={id} />
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <DeviceForm device={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
