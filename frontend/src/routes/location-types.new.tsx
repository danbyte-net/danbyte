import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { LocationTypeForm } from "@/components/location-type-form"

export const Route = createFileRoute("/location-types/new")({
  component: NewLocationTypePage,
})

function NewLocationTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Location types", to: "/location-types" },
        { label: "Add" },
      ]}
      title="Add location type"
    >
      <LocationTypeForm
        onSaved={(t) =>
          nav({ to: "/location-types/$id", params: { id: t.id } })
        }
        onCancel={() => nav({ to: "/location-types" })}
      />
    </EditPageShell>
  )
}
