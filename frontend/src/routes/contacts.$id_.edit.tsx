import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Contact } from "@/lib/api"
import { ContactForm } from "@/components/contact-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/contacts/$id_/edit")({
  component: EditContactPage,
})

function EditContactPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["contact", id],
    queryFn: () => api<Contact>(`/api/contacts/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "Contacts", to: "/contacts" },
        { label: q.data?.name ?? "…", to: "/contacts/$id", params: { id } },
        { label: "Edit" },
      ]}
      title="Edit contact"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ContactForm
          contact={q.data}
          onSaved={(c) => nav({ to: "/contacts/$id", params: { id: c.id } })}
          onCancel={() => nav({ to: "/contacts/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
