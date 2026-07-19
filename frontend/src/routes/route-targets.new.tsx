import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RtForm } from "@/components/rt-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/route-targets/new")({
  component: NewRtPage,
})

function NewRtPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Route Targets", to: "/route-targets" },
        { label: "Add" },
      ]}
      title="Add Route Target"
      subtitle="ASN:value pair shared between VRFs."
    >
      <RtForm
        onSaved={(r) => nav({ to: "/route-targets/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/route-targets" })}
      />
    </EditPageShell>
  )
}
