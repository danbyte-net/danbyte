import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type Tunnel } from "@/lib/api"
import { TunnelForm } from "@/components/tunnel-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/tunnels/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["tunnel", id],
    queryFn: () => api<Tunnel>(`/api/tunnels/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Tunnels", to: "/tunnels" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit Tunnel"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <TunnelForm
          tunnel={q.data}
          onSaved={() => nav({ to: "/tunnels" })}
          onCancel={() => nav({ to: "/tunnels" })}
        />
      )}
    </EditPageShell>
  )
}
