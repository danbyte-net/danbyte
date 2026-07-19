import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { IpStatusForm } from "@/components/ip-status-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/statuses/new")({
  component: NewIpStatusPage,
})

function NewIpStatusPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Statuses", to: "/statuses" }, { label: "Add" }]}
      title="Add status"
      subtitle="An operational status an object can carry (active, reserved, …)."
    >
      <IpStatusForm
        onSaved={(s) => nav({ to: "/statuses/$id", params: { id: s.id } })}
        onCancel={() => nav({ to: "/statuses" })}
      />
    </EditPageShell>
  )
}
