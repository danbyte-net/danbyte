import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { OSPFArea } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { OSPFAreaForm } from "@/components/routing/igp-forms"
import { ospfAreaDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/ospf-areas/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [ospfAreaDetail.queryKey, id],
    queryFn: () => api<OSPFArea>(`${ospfAreaDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/ospf-areas/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "OSPF areas", to: "/ospf-areas" },
        { label: q.data ? ospfAreaDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit OSPF area"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <OSPFAreaForm item={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
