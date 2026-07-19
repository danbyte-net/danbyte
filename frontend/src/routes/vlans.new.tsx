import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { VlanForm } from "@/components/vlan-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/vlans/new")({
  validateSearch: (s: Record<string, unknown>) => ({
    vlan_id: typeof s.vlan_id === "string" ? Number(s.vlan_id) : undefined,
  }),
  component: NewVlanPage,
})

function NewVlanPage() {
  const { vlan_id } = Route.useSearch()
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "VLANs", to: "/vlans" }, { label: "Add" }]}
      title="Add VLAN"
      subtitle="Register a new VLAN in the active tenant."
    >
      <VlanForm
        initial={{ vlanId: vlan_id }}
        onSaved={(v) => nav({ to: "/vlans/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/vlans" })}
      />
    </EditPageShell>
  )
}
