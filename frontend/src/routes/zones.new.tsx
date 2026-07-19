import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ZoneForm } from "@/components/zone-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/zones/new")({
  component: NewZonePage,
})

function NewZonePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Zones", to: "/zones" }, { label: "Add" }]}
      title="Add zone"
      subtitle="A firewall zone VLANs can be placed in (trust, untrust, dmz, …)."
    >
      <ZoneForm
        onSaved={(z) => nav({ to: "/zones/$id", params: { id: z.id } })}
        onCancel={() => nav({ to: "/zones" })}
      />
    </EditPageShell>
  )
}
