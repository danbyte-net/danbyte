import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ProviderNetworkForm } from "@/components/provider-network-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/provider-networks/new")({
  component: NewProviderNetworkPage,
})

function NewProviderNetworkPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Provider networks", to: "/provider-networks" },
        { label: "Add" },
      ]}
      title="Add provider network"
      subtitle="A network operated by a provider that circuits can terminate on (an MPLS cloud, an IX fabric…)."
    >
      <ProviderNetworkForm
        onSaved={() => nav({ to: "/provider-networks" })}
        onCancel={() => nav({ to: "/provider-networks" })}
      />
    </EditPageShell>
  )
}
