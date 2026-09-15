import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ASPathList } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { ASPathListForm } from "@/components/routing/list-forms"
import { asPathListDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/as-path-lists/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [asPathListDetail.queryKey, id],
    queryFn: () => api<ASPathList>(`${asPathListDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/as-path-lists/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "AS-path lists", to: "/as-path-lists" },
        { label: q.data ? asPathListDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit AS-path list"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ASPathListForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
