import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { LocationForm } from "@/components/location-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/locations/new")({
  component: NewLocationPage,
})

function NewLocationPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Locations", to: "/locations" }, { label: "Add" }]}
      title="Add location"
      subtitle="A physical location within a site (building, floor, room…)."
    >
      <LocationForm
        onSaved={() => nav({ to: "/locations" })}
        onCancel={() => nav({ to: "/locations" })}
      />
    </EditPageShell>
  )
}
