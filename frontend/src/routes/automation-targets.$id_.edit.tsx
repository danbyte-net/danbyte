import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type AutomationTarget } from "@/lib/api"
import { AutomationTargetForm } from "@/components/automation-target-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/automation-targets/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["automation-target", id],
    queryFn: () => api<AutomationTarget>(`/api/automation-targets/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Automation targets", to: "/automation-targets" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit automation target"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <AutomationTargetForm
          target={q.data}
          onSaved={() => nav({ to: "/automation-targets" })}
          onCancel={() => nav({ to: "/automation-targets" })}
        />
      )}
    </EditPageShell>
  )
}
