import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { StaticRoute } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { StaticRouteForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/static-routes/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["static-route", id],
    queryFn: () => api<StaticRoute>(`/api/routing/static-routes/${id}/`),
  })
  const back = () => nav({ to: "/static-routes/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Static routes", to: "/static-routes" },
        { label: q.data?.prefix ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit static route"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <StaticRouteForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
