import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { BGPSessionForm } from "@/components/routing/bgp-forms"

export const Route = createFileRoute("/bgp-sessions/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "BGP sessions", to: "/bgp-sessions" },
        { label: "Add" },
      ]}
      title="Add BGP session"
      subtitle="One neighbour on one instance. Settings left on Inherit come from the peer group."
    >
      <BGPSessionForm
        onSaved={(v) => nav({ to: "/bgp-sessions/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/bgp-sessions" })}
      />
    </EditPageShell>
  )
}
