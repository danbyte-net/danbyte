import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { TunnelGroupForm } from "@/components/tunnel-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/tunnel-groups/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Tunnel groups", to: "/tunnel-groups" },
        { label: "Add" },
      ]}
      title="Add Tunnel group"
      subtitle="An organisational grouping of tunnels."
    >
      <TunnelGroupForm
        onSaved={() => nav({ to: "/tunnel-groups" })}
        onCancel={() => nav({ to: "/tunnel-groups" })}
      />
    </EditPageShell>
  )
}
