import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { IpRoleForm } from "@/components/ip-role-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/ip-roles/new")({
  component: NewIpRolePage,
})

function NewIpRolePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "IP roles", to: "/ip-roles" }, { label: "Add" }]}
      title="Add IP role"
      subtitle="A functional role an IP can play (gateway, VIP, loopback, …)."
    >
      <IpRoleForm
        onSaved={(r) => nav({ to: "/ip-roles/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/ip-roles" })}
      />
    </EditPageShell>
  )
}
