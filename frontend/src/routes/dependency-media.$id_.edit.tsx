import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DependencyMedium } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { DependencyMediumForm } from "@/components/dependency-medium-form"

export const Route = createFileRoute("/dependency-media/$id_/edit")({
  component: EditDependencyMediumPage,
})

function EditDependencyMediumPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["dependency-medium", id],
    queryFn: () => api<DependencyMedium>(`/api/dependency-media/${id}/`),
  })
  const back = () => nav({ to: "/dependency-media/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Dependency media", to: "/dependency-media" },
        q.data
          ? { label: q.data.name, to: "/dependency-media/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit dependency medium"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <DependencyMediumForm medium={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
