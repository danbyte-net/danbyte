import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type L2VPN } from "@/lib/api"
import { L2vpnForm } from "@/components/l2vpn-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/l2vpns/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["l2vpn", id],
    queryFn: () => api<L2VPN>(`/api/l2vpns/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "L2VPNs", to: "/l2vpns" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit L2VPN"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <L2vpnForm
          l2vpn={q.data}
          onSaved={() => nav({ to: "/l2vpns" })}
          onCancel={() => nav({ to: "/l2vpns" })}
        />
      )}
    </EditPageShell>
  )
}
