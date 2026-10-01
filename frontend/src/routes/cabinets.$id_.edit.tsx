import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Cabinet } from "@/lib/api"
import { CabinetForm } from "@/components/cabinet-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cabinets/$id_/edit")({
  component: EditCabinetPage,
})

function EditCabinetPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cabinet", id],
    queryFn: () => api<Cabinet>(`/api/cabinets/${id}/`),
  })
  const backToDetail = () => nav({ to: "/cabinets/$id", params: { id } })

  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cabinets", to: "/cabinets" },
        q.data
          ? { label: q.data.name, to: "/cabinets/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit cabinet"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CabinetForm
          cabinet={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
