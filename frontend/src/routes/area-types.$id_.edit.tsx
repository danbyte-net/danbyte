import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { AreaType } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { AreaTypeForm } from "@/components/area-type-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/area-types/$id_/edit")({
  component: EditAreaTypePage,
})

function EditAreaTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["area-type", id],
    queryFn: () => api<AreaType>(`/api/area-types/${id}/`),
  })
  const back = () => nav({ to: "/area-types/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Area types", to: "/area-types" },
        q.data ? { label: q.data.name } : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit area type"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <AreaTypeForm areaType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
