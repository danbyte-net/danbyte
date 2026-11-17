import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { AccessoryType } from "@/lib/api"
import { PluggableForm } from "@/components/pluggable-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/pluggables/$id_/edit")({
  component: EditPluggablePage,
})

function EditPluggablePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["pluggable", id],
    queryFn: () => api<AccessoryType>(`/api/accessory-types/${id}/`),
  })
  const back = () => nav({ to: "/pluggables/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Pluggables", to: "/pluggables" },
        { label: q.data?.name ?? "…" },
      ]}
      title={`Edit ${q.data?.name ?? "pluggable"}`}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <PluggableForm part={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
