import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { VrfForm } from "@/components/vrf-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/vrfs/new")({
  component: NewVrfPage,
})

function NewVrfPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "VRFs", to: "/vrfs" }, { label: "Add" }]}
      title="Add VRF"
      subtitle="Register a new routing context."
    >
      <VrfForm
        onSaved={(v) => nav({ to: "/vrfs/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/vrfs" })}
      />
    </EditPageShell>
  )
}
