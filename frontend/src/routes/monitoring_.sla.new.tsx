import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { SlaAgreementForm } from "@/components/monitoring/sla-agreement-form"
import { SlaWizard } from "@/components/monitoring/sla-wizard"

export const Route = createFileRoute("/monitoring_/sla/new")({
  component: NewSlaAgreementPage,
  // `?full=1`: every setting on one form instead of the three steps.
  validateSearch: (s: Record<string, unknown>): { full?: boolean } =>
    s.full === true || s.full === "1" || s.full === 1 ? { full: true } : {},
})

function NewSlaAgreementPage() {
  const nav = useNavigate()
  const { full } = Route.useSearch()
  const created = (a: { id: string }) =>
    nav({ to: "/monitoring/sla/$id", params: { id: a.id } })
  const cancel = () =>
    nav({ to: "/monitoring", search: { view: "sla", status: "all" } })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Monitoring", to: "/monitoring" },
        { label: "New SLA" },
      ]}
      title="New service level agreement"
    >
      {full ? (
        <SlaAgreementForm onSaved={created} onCancel={cancel} />
      ) : (
        <SlaWizard
          onCreated={created}
          onCancel={cancel}
          onFullForm={() =>
            nav({ to: "/monitoring/sla/new", search: { full: true } })
          }
        />
      )}
    </EditPageShell>
  )
}
