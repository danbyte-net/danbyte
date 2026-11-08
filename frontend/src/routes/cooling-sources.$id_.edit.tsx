import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { CoolingSource } from "@/lib/api"
import { CoolingSourceForm } from "@/components/cooling-source-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cooling-sources/$id_/edit")({
  component: EditCoolingSourcePage,
})

function EditCoolingSourcePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cooling-source", id],
    queryFn: () => api<CoolingSource>(`/api/cooling-sources/${id}/`),
  })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cooling sources", to: "/cooling-sources" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit cooling source"
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CoolingSourceForm
          source={q.data}
          onSaved={() => nav({ to: "/cooling-sources/$id", params: { id } })}
          onCancel={() => nav({ to: "/cooling-sources/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
