import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { BGPSession } from "@/lib/api"
import { sessionNeighbor } from "@/components/columns/routing-columns"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { BGPSessionForm } from "@/components/routing/bgp-forms"

export const Route = createFileRoute("/bgp-sessions/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["bgp-session", id],
    queryFn: () => api<BGPSession>(`/api/routing/bgp-sessions/${id}/`),
  })
  const back = () => nav({ to: "/bgp-sessions/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "BGP sessions", to: "/bgp-sessions" },
        { label: q.data ? sessionNeighbor(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit BGP session"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <BGPSessionForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
