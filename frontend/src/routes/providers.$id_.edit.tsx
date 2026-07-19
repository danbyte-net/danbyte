import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type Provider } from "@/lib/api"
import { ProviderForm } from "@/components/provider-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/providers/$id_/edit")({
  component: EditProviderPage,
})

function EditProviderPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["provider", id],
    queryFn: () => api<Provider>(`/api/providers/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Providers", to: "/providers" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit provider"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ProviderForm
          provider={q.data}
          onSaved={() => nav({ to: "/providers" })}
          onCancel={() => nav({ to: "/providers" })}
        />
      )}
    </EditPageShell>
  )
}
