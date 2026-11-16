import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { SlaAgreementForm } from "@/components/monitoring/sla-agreement-form"

export const Route = createFileRoute("/monitoring_/sla/templates/new")({
  component: NewSlaTemplatePage,
})

function NewSlaTemplatePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "SLAs", to: "/monitoring/sla" },
        { label: "New SLA template" },
      ]}
      title="New SLA template"
    >
      <SlaAgreementForm
        asTemplate
        onSaved={(t) =>
          nav({ to: "/monitoring/sla/templates/$id", params: { id: t.id } })
        }
        onCancel={() => nav({ to: "/monitoring/sla" })}
      />
    </EditPageShell>
  )
}
