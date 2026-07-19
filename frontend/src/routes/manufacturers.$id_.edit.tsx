import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Manufacturer } from "@/lib/api"
import { ManufacturerForm } from "@/components/manufacturer-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/manufacturers/$id_/edit")({
  component: EditManufacturerPage,
})

function EditManufacturerPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["manufacturer", id],
    queryFn: () => api<Manufacturer>(`/api/manufacturers/${id}/`),
  })
  const back = () => nav({ to: "/manufacturers/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Manufacturers", to: "/manufacturers" },
        q.data
          ? { label: q.data.name, to: "/manufacturers/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit manufacturer"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ManufacturerForm
          manufacturer={q.data}
          onSaved={back}
          onCancel={back}
        />
      )}
    </EditPageShell>
  )
}
