import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { WebhookForm } from "@/components/webhook-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/webhooks/new")({
  component: NewWebhookPage,
})

function NewWebhookPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Webhooks", to: "/webhooks" }, { label: "Add" }]}
      title="Add webhook"
      subtitle="POST a payload to an external URL when objects change."
    >
      <WebhookForm
        onSaved={() => nav({ to: "/webhooks" })}
        onCancel={() => nav({ to: "/webhooks" })}
      />
    </EditPageShell>
  )
}
