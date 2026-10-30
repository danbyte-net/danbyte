import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { LocationType } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { LocationTypeForm } from "@/components/location-type-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/location-types/$id_/edit")({
  component: EditLocationTypePage,
})

function EditLocationTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["location-type", id],
    queryFn: () => api<LocationType>(`/api/location-types/${id}/`),
  })
  const back = () => nav({ to: "/location-types/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Location types", to: "/location-types" },
        q.data ? { label: q.data.name } : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit location type"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <LocationTypeForm
          locationType={q.data}
          onSaved={back}
          onCancel={back}
        />
      )}
    </EditPageShell>
  )
}
