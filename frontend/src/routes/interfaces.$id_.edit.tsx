import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Interface } from "@/lib/api"
import { InterfaceForm } from "@/components/interface-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { PlanModeBanner } from "@/components/planning/plan-mode-banner"
import { PendingFieldsProvider } from "@/lib/pending-fields"
import { planSearch } from "@/lib/save-object"

export const Route = createFileRoute("/interfaces/$id_/edit")({
  // Plan mode: ?plan=<taskId>&planBoard=<boardId> turns this form into
  // "record what changed on that task" instead of writing.
  validateSearch: (s: Record<string, unknown>) => planSearch(s),
  component: EditInterfacePage,
})

function EditInterfacePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["interface", id],
    queryFn: () => api<Interface>(`/api/interfaces/${id}/`),
  })
  const back = () => nav({ to: "/interfaces/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Interfaces", to: "/interfaces" },
        q.data
          ? { label: q.data.name, to: "/interfaces/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit interface"}
    >
      <PlanModeBanner />
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      <PendingFieldsProvider objectType="api.interface" objectId={id}>
        {q.data && (
          <InterfaceForm iface={q.data} onSaved={back} onCancel={back} />
        )}
      </PendingFieldsProvider>
    </EditPageShell>
  )
}
