import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ManufacturerForm } from "@/components/manufacturer-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/manufacturers/new")({
  component: NewManufacturerPage,
})

function NewManufacturerPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Manufacturers", to: "/manufacturers" },
        { label: "Add" },
      ]}
      title="Add manufacturer"
      subtitle="A device maker (Cisco, Dell, Juniper, …)."
    >
      <ManufacturerForm
        onSaved={(m) => nav({ to: "/manufacturers/$id", params: { id: m.id } })}
        onCancel={() => nav({ to: "/manufacturers" })}
      />
    </EditPageShell>
  )
}
