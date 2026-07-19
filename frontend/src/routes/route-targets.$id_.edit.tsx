import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type RouteTarget } from "@/lib/api"
import { RtForm } from "@/components/rt-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/route-targets/$id_/edit")({
  component: EditRtPage,
})

function EditRtPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["rt", id],
    queryFn: () => api<RouteTarget>(`/api/route-targets/${id}/`),
  })
  const backToDetail = () => nav({ to: "/route-targets/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Route Targets", to: "/route-targets" },
        q.data
          ? { label: q.data.name, to: "/route-targets/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit RT"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RtForm rt={q.data} onSaved={backToDetail} onCancel={backToDetail} />
      )}
    </EditPageShell>
  )
}
