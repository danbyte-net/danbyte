import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type MaintenanceEvent } from "@/lib/api"
import { MaintenanceEventForm } from "@/components/monitoring/maintenance-event-form"
import { EventImpactPanel } from "@/components/monitoring/event-impact-panel"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/maintenance/$id_/edit")({
  component: EditMaintenanceEventPage,
})

function EditMaintenanceEventPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["maintenance-event", id],
    queryFn: () =>
      api<MaintenanceEvent>(`/api/monitoring/maintenance-events/${id}/`),
  })
  const back = () => nav({ to: "/maintenance" })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Maintenance", to: "/maintenance" },
        { label: q.data?.name ?? "…" },
      ]}
      title={q.data ? q.data.name : "Edit event"}
      subtitle={q.data?.recurrence_summary || undefined}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <div className="grid gap-8">
          <MaintenanceEventForm event={q.data} onSaved={back} onCancel={back} />
          <EventImpactPanel event={q.data} />
        </div>
      )}
    </EditPageShell>
  )
}
