import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Rack } from "@/lib/api"
import { RackForm } from "@/components/rack-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/racks/$id_/edit")({
  component: EditRackPage,
})

function EditRackPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["rack", id],
    queryFn: () => api<Rack>(`/api/racks/${id}/`),
  })
  const backToDetail = () => nav({ to: "/racks/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Racks", to: "/racks" },
        q.data
          ? { label: q.data.name, to: "/racks/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit rack"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RackForm
          rack={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
