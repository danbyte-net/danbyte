import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { EthernetSegment } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { EthernetSegmentForm } from "@/components/routing/object-forms"
import { ethernetSegmentDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/ethernet-segments/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [ethernetSegmentDetail.queryKey, id],
    queryFn: () =>
      api<EthernetSegment>(`${ethernetSegmentDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/ethernet-segments/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Ethernet segments", to: "/ethernet-segments" },
        { label: q.data ? ethernetSegmentDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit Ethernet segment"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <EthernetSegmentForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
