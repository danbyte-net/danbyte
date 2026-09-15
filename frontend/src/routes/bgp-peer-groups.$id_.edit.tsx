import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { BGPPeerGroup } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { BGPPeerGroupForm } from "@/components/routing/bgp-forms"
import { peerGroupDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/bgp-peer-groups/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [peerGroupDetail.queryKey, id],
    queryFn: () => api<BGPPeerGroup>(`${peerGroupDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/bgp-peer-groups/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "BGP peer groups", to: "/bgp-peer-groups" },
        { label: q.data ? peerGroupDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit peer group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <BGPPeerGroupForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
