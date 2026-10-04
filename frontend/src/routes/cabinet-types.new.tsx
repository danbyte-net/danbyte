import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CabinetTypeForm } from "@/components/cabinet-type-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/cabinet-types/new")({
  component: NewCabinetTypePage,
})

function NewCabinetTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cabinet types", to: "/cabinet-types" },
        { label: "Add" },
      ]}
      title="Add cabinet type"
      subtitle="An enclosure model - its sizes pre-fill new cabinets."
    >
      <CabinetTypeForm
        onSaved={(t) => nav({ to: "/cabinet-types/$id", params: { id: t.id } })}
        onCancel={() => nav({ to: "/cabinet-types" })}
      />
    </EditPageShell>
  )
}
