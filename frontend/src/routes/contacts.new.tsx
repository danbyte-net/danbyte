import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ContactForm } from "@/components/contact-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/contacts/new")({
  component: NewContactPage,
})

function NewContactPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Contacts", to: "/contacts" }, { label: "Add" }]}
      title="Add contact"
      subtitle="A person or team you can attach to objects."
    >
      <ContactForm
        onSaved={(c) => nav({ to: "/contacts/$id", params: { id: c.id } })}
        onCancel={() => nav({ to: "/contacts" })}
      />
    </EditPageShell>
  )
}
