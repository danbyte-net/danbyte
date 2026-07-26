import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RackForm } from "@/components/rack-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/racks/new")({
  // ?rack_type=<id> pre-picks the cabinet model — how the rack-type page's
  // "Add rack" lands here with the profile already chosen.
  validateSearch: (s: Record<string, unknown>): { rack_type?: string } => ({
    rack_type: typeof s.rack_type === "string" ? s.rack_type : undefined,
  }),
  component: NewRackPage,
})

function NewRackPage() {
  const nav = useNavigate()
  const { rack_type } = Route.useSearch()
  return (
    <EditPageShell
      crumbs={[{ label: "Racks", to: "/racks" }, { label: "Add" }]}
      title="Add rack"
      subtitle="A physical equipment rack that holds devices by unit."
    >
      <RackForm
        initialRackTypeId={rack_type}
        onSaved={(r) => nav({ to: "/racks/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/racks" })}
      />
    </EditPageShell>
  )
}
