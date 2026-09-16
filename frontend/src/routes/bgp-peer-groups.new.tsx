import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { BGPPeerGroupForm } from "@/components/routing/bgp-forms"

export const Route = createFileRoute("/bgp-peer-groups/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "BGP peer groups", to: "/bgp-peer-groups" },
        { label: "Add" },
      ]}
      title="Add peer group"
      subtitle="Neighbor settings named once and applied on every session that joins the group."
    >
      <BGPPeerGroupForm
        onSaved={(v) =>
          nav({ to: "/bgp-peer-groups/$id", params: { id: v.id } })
        }
        onCancel={() => nav({ to: "/bgp-peer-groups" })}
      />
    </EditPageShell>
  )
}
