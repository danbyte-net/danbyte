import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type RBACGroup } from "@/lib/api"
import { GroupForm } from "@/components/group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/groups/$id_/edit")({
  component: EditGroupPage,
})

function EditGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["group", Number(id)],
    queryFn: () => api<RBACGroup>(`/api/groups/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Groups", to: "/groups" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <GroupForm
          group={q.data}
          onSaved={() => nav({ to: "/groups" })}
          onCancel={() => nav({ to: "/groups" })}
        />
      )}
    </EditPageShell>
  )
}
