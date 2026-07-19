import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ContactRoleForm } from "@/components/contact-role-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/contact-roles/new")({
  component: NewContactRolePage,
})

function NewContactRolePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Contact roles", to: "/contact-roles" },
        { label: "Add" },
      ]}
      title="Add role"
    >
      <ContactRoleForm
        onSaved={() => nav({ to: "/contact-roles" })}
        onCancel={() => nav({ to: "/contact-roles" })}
      />
    </EditPageShell>
  )
}
