import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ContactGroup } from "@/lib/api"
import { ContactGroupForm } from "@/components/contact-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/contact-groups/$id_/edit")({
  component: EditContactGroupPage,
})

function EditContactGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["contact-group", id],
    queryFn: () => api<ContactGroup>(`/api/contact-groups/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "Contact groups", to: "/contact-groups" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ContactGroupForm
          item={q.data}
          onSaved={() => nav({ to: "/contact-groups" })}
          onCancel={() => nav({ to: "/contact-groups" })}
        />
      )}
    </EditPageShell>
  )
}
