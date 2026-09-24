import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SlaAgreement } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { SlaAgreementForm } from "@/components/monitoring/sla-agreement-form"

export const Route = createFileRoute("/monitoring_/sla/$id_/edit")({
  component: EditSlaAgreementPage,
})

function EditSlaAgreementPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["sla-agreement", id],
    queryFn: () => api<SlaAgreement>(`/api/monitoring/sla-agreements/${id}/`),
  })
  const back = () => nav({ to: "/monitoring/sla/$id", params: { id } })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Monitoring", to: "/monitoring" },
        {
          label: q.data?.name ?? "…",
          to: "/monitoring/sla/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title={q.data ? q.data.name : "Edit agreement"}
    >
      {q.isLoading && (
        <p className="text-sm text-muted-foreground">Loading...</p>
      )}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <SlaAgreementForm agreement={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
