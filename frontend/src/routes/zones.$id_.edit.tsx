import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Zone } from "@/lib/api"
import { ZoneForm } from "@/components/zone-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/zones/$id_/edit")({
  component: EditZonePage,
})

function EditZonePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["zone", id],
    queryFn: () => api<Zone>(`/api/zones/${id}/`),
  })
  const back = () => nav({ to: "/zones/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Zones", to: "/zones" },
        q.data
          ? { label: q.data.name, to: "/zones/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit zone"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <ZoneForm zone={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
