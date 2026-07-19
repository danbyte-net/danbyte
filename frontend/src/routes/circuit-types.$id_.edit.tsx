import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type CircuitType } from "@/lib/api"
import { CircuitTypeForm } from "@/components/circuit-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/circuit-types/$id_/edit")({
  component: EditCircuitTypePage,
})

function EditCircuitTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["circuit-type", id],
    queryFn: () => api<CircuitType>(`/api/circuit-types/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Circuit types", to: "/circuit-types" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit circuit type"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CircuitTypeForm
          item={q.data}
          onSaved={() => nav({ to: "/circuit-types" })}
          onCancel={() => nav({ to: "/circuit-types" })}
        />
      )}
    </EditPageShell>
  )
}
