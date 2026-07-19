import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RackForm } from "@/components/rack-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/racks/new")({
  component: NewRackPage,
})

function NewRackPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Racks", to: "/racks" }, { label: "Add" }]}
      title="Add rack"
      subtitle="A physical equipment rack that holds devices by unit."
    >
      <RackForm
        onSaved={(r) => nav({ to: "/racks/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/racks" })}
      />
    </EditPageShell>
  )
}
