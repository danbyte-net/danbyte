import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SlaTemplate } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SlaAgreementForm } from "@/components/monitoring/sla-agreement-form"

export const Route = createFileRoute("/monitoring_/sla/templates/$id_/edit")({
  component: EditSlaTemplatePage,
})

function EditSlaTemplatePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["sla-template", id],
    queryFn: () => api<SlaTemplate>(`/api/monitoring/sla-templates/${id}/`),
  })
  const back = () =>
    nav({ to: "/monitoring/sla/templates/$id", params: { id } })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Monitoring", to: "/monitoring" },
        {
          label: q.data?.name ?? "…",
          to: "/monitoring/sla/templates/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title={q.data ? q.data.name : "Edit template"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <SlaAgreementForm
          asTemplate
          template={q.data}
          onSaved={back}
          onCancel={back}
        />
      )}
    </EditPageShell>
  )
}
