import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type Circuit } from "@/lib/api"
import { CircuitForm } from "@/components/circuit-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/circuits/$id_/edit")({
  component: EditCircuitPage,
})

function EditCircuitPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["circuit", id],
    queryFn: () => api<Circuit>(`/api/circuits/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Circuits", to: "/circuits" },
        { label: q.data?.cid ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit circuit"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CircuitForm
          circuit={q.data}
          onSaved={() => nav({ to: "/circuits" })}
          onCancel={() => nav({ to: "/circuits" })}
        />
      )}
    </EditPageShell>
  )
}
