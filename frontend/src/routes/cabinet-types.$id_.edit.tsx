import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { CabinetType } from "@/lib/api"
import { CabinetTypeForm } from "@/components/cabinet-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cabinet-types/$id_/edit")({
  component: EditCabinetTypePage,
})

function EditCabinetTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cabinet-type", id],
    queryFn: () => api<CabinetType>(`/api/cabinet-types/${id}/`),
  })
  const back = () => nav({ to: "/cabinet-types/$id", params: { id } })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cabinet types", to: "/cabinet-types" },
        q.data
          ? { label: q.data.name, to: "/cabinet-types/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit cabinet type"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CabinetTypeForm cabinetType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
