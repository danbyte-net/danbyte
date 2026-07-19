import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { FhrpGroupForm } from "@/components/fhrp-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/fhrp-groups/new")({
  component: NewFhrpGroupPage,
})

function NewFhrpGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "FHRP groups", to: "/fhrp-groups" }, { label: "Add" }]}
      title="Add FHRP group"
      subtitle="A VRRP/HSRP/GLBP/CARP group sharing a virtual IP."
    >
      <FhrpGroupForm
        onSaved={(g) => nav({ to: "/fhrp-groups/$id", params: { id: g.id } })}
        onCancel={() => nav({ to: "/fhrp-groups" })}
      />
    </EditPageShell>
  )
}
