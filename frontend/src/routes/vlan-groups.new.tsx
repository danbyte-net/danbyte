import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { VlanGroupForm } from "@/components/vlan-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/vlan-groups/new")({
  component: NewVlanGroupPage,
})

function NewVlanGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "VLAN groups", to: "/vlan-groups" }, { label: "Add" }]}
      title="Add VLAN group"
      subtitle="Scopes VID uniqueness and constrains the VID range."
    >
      <VlanGroupForm
        onSaved={(g) => nav({ to: "/vlan-groups/$id", params: { id: g.id } })}
        onCancel={() => nav({ to: "/vlan-groups" })}
      />
    </EditPageShell>
  )
}
