import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type TunnelGroup } from "@/lib/api"
import { TunnelGroupForm } from "@/components/tunnel-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/tunnel-groups/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["tunnel-group", id],
    queryFn: () => api<TunnelGroup>(`/api/tunnel-groups/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Tunnel groups", to: "/tunnel-groups" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit Tunnel group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <TunnelGroupForm
          item={q.data}
          onSaved={() => nav({ to: "/tunnel-groups" })}
          onCancel={() => nav({ to: "/tunnel-groups" })}
        />
      )}
    </EditPageShell>
  )
}
