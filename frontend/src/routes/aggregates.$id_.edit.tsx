import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Aggregate } from "@/lib/api"
import { AggregateForm } from "@/components/aggregate-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/aggregates/$id_/edit")({
  component: EditAggregatePage,
})

function EditAggregatePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["aggregate", id],
    queryFn: () => api<Aggregate>(`/api/aggregates/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "Aggregates", to: "/aggregates" },
        {
          label: q.data?.prefix ?? "…",
          to: "/aggregates/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title="Edit aggregate"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <AggregateForm
          aggregate={q.data}
          onSaved={(a) => nav({ to: "/aggregates/$id", params: { id: a.id } })}
          onCancel={() => nav({ to: "/aggregates/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
