import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RackTypeForm } from "@/components/rack-type-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/rack-types/new")({
  component: NewRackTypePage,
})

function NewRackTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[{ label: "Rack types", to: "/rack-types" }, { label: "Add" }]}
      title="Add rack type"
      subtitle="A cabinet model - its dimensions pre-fill new racks, and its accessories can stamp factory-fitted PDU strips."
    >
      <RackTypeForm
        onSaved={(rt) => nav({ to: "/rack-types/$id", params: { id: rt.id } })}
        onCancel={() => nav({ to: "/rack-types" })}
      />
    </EditPageShell>
  )
}
