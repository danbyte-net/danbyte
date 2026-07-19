import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type RBACUser, type UserAccessSummary } from "@/lib/api"
import { UserForm } from "@/components/user-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"

export const Route = createFileRoute("/users/$id_/edit")({
  component: EditUserPage,
})

// A plain-language read of what this user can do, so an admin doesn't decode
// ObjectPermission rows. Admin-only endpoint; failures just hide the banner.
function AccessSummary({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["user-access", id],
    queryFn: () => api<UserAccessSummary>(`/api/users/${id}/access-summary/`),
    retry: false,
  })
  const s = q.data
  if (!s) return null
  if (s.is_admin)
    return (
      <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        <span className="font-medium">Administrator</span> — full access in this
        tenant.
      </div>
    )
  const editLabel =
    s.edit_scope === "all"
      ? "edits everything"
      : s.edit_scope === "sites"
        ? "edits their sites"
        : "read-only"
  const readLabel =
    s.read_scope === "all" ? "reads everything" : "reads their sites"
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
      <span className="text-muted-foreground">Access:</span>
      <span className="font-medium">{editLabel}</span>
      <span className="text-muted-foreground">·</span>
      <span>{readLabel}</span>
      {s.editable_sites.map((site) => (
        <Badge key={site.id} variant="secondary" className="text-[11px]">
          {site.name}
        </Badge>
      ))}
    </div>
  )
}

function EditUserPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["user", Number(id)],
    queryFn: () => api<RBACUser>(`/api/users/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Users", to: "/users" },
        { label: q.data?.username ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit user"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <>
          <AccessSummary id={id} />
          <UserForm
            user={q.data}
            onSaved={() => nav({ to: "/users" })}
            onCancel={() => nav({ to: "/users" })}
          />
        </>
      )}
    </EditPageShell>
  )
}
