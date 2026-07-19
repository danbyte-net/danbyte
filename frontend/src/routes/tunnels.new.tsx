import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { TunnelForm } from "@/components/tunnel-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/tunnels/new")({ component: NewPage })

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Tunnels", to: "/tunnels" }, { label: "Add" }]}
      title="Add Tunnel"
      subtitle="A VPN tunnel."
    >
      <TunnelForm
        onSaved={() => nav({ to: "/tunnels" })}
        onCancel={() => nav({ to: "/tunnels" })}
      />
    </EditPageShell>
  )
}
