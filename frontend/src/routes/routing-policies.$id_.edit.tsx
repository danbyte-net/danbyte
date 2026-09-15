import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RoutingPolicy } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { RoutingPolicyForm } from "@/components/routing/list-forms"
import { routingPolicyDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/routing-policies/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [routingPolicyDetail.queryKey, id],
    queryFn: () => api<RoutingPolicy>(`${routingPolicyDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/routing-policies/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Routing policies", to: "/routing-policies" },
        { label: q.data ? routingPolicyDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit routing policy"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RoutingPolicyForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
