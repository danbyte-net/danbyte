import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { CommunityList } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { CommunityListForm } from "@/components/routing/list-forms"
import { communityListDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/community-lists/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [communityListDetail.queryKey, id],
    queryFn: () => api<CommunityList>(`${communityListDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/community-lists/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Community lists", to: "/community-lists" },
        { label: q.data ? communityListDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit community list"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CommunityListForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
