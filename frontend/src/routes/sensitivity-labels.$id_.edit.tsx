import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SensitivityLabel } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SensitivityLabelForm } from "@/components/sensitivity-label-form"

export const Route = createFileRoute("/sensitivity-labels/$id_/edit")({
  component: EditSensitivityLabelPage,
})

function EditSensitivityLabelPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["sensitivity-label", id],
    queryFn: () => api<SensitivityLabel>(`/api/sensitivity-labels/${id}/`),
  })
  const back = () => nav({ to: "/sensitivity-labels/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Sensitivity labels", to: "/sensitivity-labels" },
        q.data ? { label: q.data.name } : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit sensitivity label"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <SensitivityLabelForm label={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
