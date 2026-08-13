import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { MaintenanceEventForm } from "@/components/monitoring/maintenance-event-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/maintenance/new")({
  component: NewMaintenanceEventPage,
})

function NewMaintenanceEventPage() {
  const nav = useNavigate()
  const back = () => nav({ to: "/maintenance" })
  return (
    <EditPageShell
      crumbs={[{ label: "Maintenance", to: "/maintenance" }, { label: "New" }]}
      title="New maintenance or outage event"
    >
      <MaintenanceEventForm onSaved={back} onCancel={back} />
    </EditPageShell>
  )
}
