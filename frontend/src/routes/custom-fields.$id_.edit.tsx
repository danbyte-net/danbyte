import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type CustomField } from "@/lib/api"
import { CustomFieldForm } from "@/components/custom-field-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/custom-fields/$id_/edit")({
  component: EditCustomFieldPage,
})

function EditCustomFieldPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["custom-field", id],
    queryFn: () => api<CustomField>(`/api/custom-fields/${id}/`),
  })
  const backToDetail = () => nav({ to: "/custom-fields/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Custom fields", to: "/custom-fields" },
        q.data
          ? { label: q.data.label, to: "/custom-fields/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.label}` : "Edit custom field"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CustomFieldForm
          field={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
