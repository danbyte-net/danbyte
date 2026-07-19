import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ContactRole } from "@/lib/api"
import { ContactRoleForm } from "@/components/contact-role-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/contact-roles/$id_/edit")({
  component: EditContactRolePage,
})

function EditContactRolePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["contact-role", id],
    queryFn: () => api<ContactRole>(`/api/contact-roles/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "Contact roles", to: "/contact-roles" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit role"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ContactRoleForm
          item={q.data}
          onSaved={() => nav({ to: "/contact-roles" })}
          onCancel={() => nav({ to: "/contact-roles" })}
        />
      )}
    </EditPageShell>
  )
}
