import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ContactGroupForm } from "@/components/contact-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/contact-groups/new")({
  component: NewContactGroupPage,
})

function NewContactGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Contact groups", to: "/contact-groups" },
        { label: "Add" },
      ]}
      title="Add group"
    >
      <ContactGroupForm
        onSaved={() => nav({ to: "/contact-groups" })}
        onCancel={() => nav({ to: "/contact-groups" })}
      />
    </EditPageShell>
  )
}
