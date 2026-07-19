import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ServiceTemplate } from "@/lib/api"
import { ServiceTemplateForm } from "@/components/service-template-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/service-templates/$id_/edit")({
  component: EditServiceTemplatePage,
})

function EditServiceTemplatePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["service-template", id],
    queryFn: () => api<ServiceTemplate>(`/api/service-templates/${id}/`),
  })
  const back = () => nav({ to: "/service-templates/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Service templates", to: "/service-templates" },
        q.data
          ? { label: q.data.name, to: "/service-templates/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit template"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ServiceTemplateForm template={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
