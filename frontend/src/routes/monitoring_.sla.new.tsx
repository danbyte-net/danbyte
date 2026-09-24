import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { SlaAgreementForm } from "@/components/monitoring/sla-agreement-form"

export const Route = createFileRoute("/monitoring_/sla/new")({
  component: NewSlaAgreementPage,
})

function NewSlaAgreementPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Monitoring", to: "/monitoring" },
        { label: "New SLA" },
      ]}
      title="New service level agreement"
    >
      <SlaAgreementForm
        onSaved={(a) =>
          nav({ to: "/monitoring/sla/$id", params: { id: a.id } })
        }
        onCancel={() =>
          nav({ to: "/monitoring", search: { view: "sla", status: "all" } })
        }
      />
    </EditPageShell>
  )
}
