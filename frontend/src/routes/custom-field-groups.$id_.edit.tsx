import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type CustomFieldGroup } from "@/lib/api"
import { CustomFieldGroupForm } from "@/components/custom-field-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/custom-field-groups/$id_/edit")({
  component: EditCustomFieldGroupPage,
})

function EditCustomFieldGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["custom-field-group", id],
    queryFn: () => api<CustomFieldGroup>(`/api/custom-field-groups/${id}/`),
  })
  const backToList = () => nav({ to: "/custom-field-groups" })

  return (
    <EditPageShell
      crumbs={[
        { label: "Custom field groups", to: "/custom-field-groups" },
        q.data ? { label: q.data.name } : { label: "…" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit custom field group"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CustomFieldGroupForm
          group={q.data}
          onSaved={backToList}
          onCancel={backToList}
        />
      )}
    </EditPageShell>
  )
}
