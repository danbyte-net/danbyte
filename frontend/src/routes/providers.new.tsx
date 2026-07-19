import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ProviderForm } from "@/components/provider-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/providers/new")({
  component: NewProviderPage,
})

function NewProviderPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Providers", to: "/providers" }, { label: "Add" }]}
      title="Add provider"
      subtitle="A telecom/transit provider that supplies circuits."
    >
      <ProviderForm
        onSaved={() => nav({ to: "/providers" })}
        onCancel={() => nav({ to: "/providers" })}
      />
    </EditPageShell>
  )
}
