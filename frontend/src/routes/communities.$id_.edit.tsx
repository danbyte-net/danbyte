import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Community } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { CommunityForm } from "@/components/routing/object-forms"
import { communityDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/communities/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [communityDetail.queryKey, id],
    queryFn: () => api<Community>(`${communityDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/communities/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Communities", to: "/communities" },
        { label: q.data ? communityDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit community"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <CommunityForm item={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
