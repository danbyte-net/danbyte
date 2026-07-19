import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type ProviderNetwork } from "@/lib/api"
import { ProviderNetworkForm } from "@/components/provider-network-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/provider-networks/$id_/edit")({
  component: EditProviderNetworkPage,
})

function EditProviderNetworkPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["provider-network", id],
    queryFn: () => api<ProviderNetwork>(`/api/provider-networks/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Provider networks", to: "/provider-networks" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit provider network"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ProviderNetworkForm
          network={q.data}
          onSaved={() => nav({ to: "/provider-networks" })}
          onCancel={() => nav({ to: "/provider-networks" })}
        />
      )}
    </EditPageShell>
  )
}
