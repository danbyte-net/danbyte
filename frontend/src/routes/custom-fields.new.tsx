import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CustomFieldForm } from "@/components/custom-field-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/custom-fields/new")({
  component: NewCustomFieldPage,
})

function NewCustomFieldPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Custom fields", to: "/custom-fields" },
        { label: "Add" },
      ]}
      title="Add custom field"
      subtitle="Declare a field that extends the custom_fields data on your objects."
    >
      <CustomFieldForm
        onSaved={(f) => nav({ to: "/custom-fields/$id", params: { id: f.id } })}
        onCancel={() => nav({ to: "/custom-fields" })}
      />
    </EditPageShell>
  )
}
