import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { L2vpnForm } from "@/components/l2vpn-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/l2vpns/new")({ component: NewPage })

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "L2VPNs", to: "/l2vpns" }, { label: "Add" }]}
      title="Add L2VPN"
      subtitle="A layer-2 VPN overlay (EVPN, VXLAN, VPWS, …)."
    >
      <L2vpnForm
        onSaved={() => nav({ to: "/l2vpns" })}
        onCancel={() => nav({ to: "/l2vpns" })}
      />
    </EditPageShell>
  )
}
