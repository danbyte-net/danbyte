import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CustomFieldGroupForm } from "@/components/custom-field-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/custom-field-groups/new")({
  component: NewCustomFieldGroupPage,
})

function NewCustomFieldGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Custom field groups", to: "/custom-field-groups" },
        { label: "Add" },
      ]}
      title="Add custom field group"
      subtitle="Group related custom fields into a labelled section on detail pages."
    >
      <CustomFieldGroupForm
        onSaved={() => nav({ to: "/custom-field-groups" })}
        onCancel={() => nav({ to: "/custom-field-groups" })}
      />
    </EditPageShell>
  )
}
