import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { type VLAN } from "@/lib/api"
import { VlanForm } from "@/components/vlan-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { planSearch } from "@/lib/save-object"
import { useCloneSeed } from "@/lib/use-clone"

export const Route = createFileRoute("/vlans/new")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(typeof s.vlan_id === "string" ? { vlan_id: Number(s.vlan_id) } : {}),
    ...(typeof s.clone === "string" ? { clone: s.clone } : {}),
    ...planSearch(s),
  }),
  component: NewVlanPage,
})

function NewVlanPage() {
  const { vlan_id, clone } = Route.useSearch()
  const nav = useNavigate()
  const cloneQ = useCloneSeed<Partial<VLAN>>("vlans", clone)
  const cloning = !!clone
  return (
    <EditPageShell
      crumbs={[
        { label: "VLANs", to: "/vlans" },
        { label: cloning ? "Clone" : "Add" },
      ]}
      title={cloning ? "Clone VLAN" : "Add VLAN"}
      subtitle={
        cloning
          ? "Site, group and description carried over - pick a new VID and name."
          : "Register a new VLAN in the active tenant."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <VlanForm
          initial={{ vlanId: vlan_id }}
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(v) => nav({ to: "/vlans/$id", params: { id: v.id } })}
          onCancel={() => nav({ to: "/vlans" })}
        />
      )}
    </EditPageShell>
  )
}
