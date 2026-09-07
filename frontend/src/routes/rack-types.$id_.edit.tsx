import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RackType } from "@/lib/api"
import { RackTypeForm } from "@/components/rack-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/rack-types/$id_/edit")({
  component: EditRackTypePage,
})

function EditRackTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["rack-type", id],
    queryFn: () => api<RackType>(`/api/rack-types/${id}/`),
  })
  const back = () => nav({ to: "/rack-types/$id", params: { id } })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Rack types", to: "/rack-types" },
        { label: q.data?.name ?? "…" },
      ]}
      title={`Edit ${q.data?.name ?? "rack type"}`}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RackTypeForm rackType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
