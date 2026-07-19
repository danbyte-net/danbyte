import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type Webhook } from "@/lib/api"
import { WebhookForm } from "@/components/webhook-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/webhooks/$id_/edit")({
  component: EditWebhookPage,
})

function EditWebhookPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["webhook", id],
    queryFn: () => api<Webhook>(`/api/webhooks/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Webhooks", to: "/webhooks" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit webhook"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <WebhookForm
          webhook={q.data}
          onSaved={() => nav({ to: "/webhooks" })}
          onCancel={() => nav({ to: "/webhooks" })}
        />
      )}
    </EditPageShell>
  )
}
