import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Cable } from "@/lib/api"
import { CableForm } from "@/components/cable-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cables/$id_/edit")({
  component: EditCablePage,
})

function EditCablePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cable", id],
    queryFn: () => api<Cable>(`/api/cables/${id}/`),
  })
  const back = () => nav({ to: "/cables/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Cables", to: "/cables" },
        q.data
          ? { label: "Cable", to: "/cables/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title="Edit cable"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <CableForm cable={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
