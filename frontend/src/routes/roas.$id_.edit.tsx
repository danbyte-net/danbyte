import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ROA } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { ROAForm } from "@/components/routing/object-forms"
import { roaDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/roas/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [roaDetail.queryKey, id],
    queryFn: () => api<ROA>(`${roaDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/roas/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "ROAs", to: "/roas" },
        { label: q.data ? roaDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit ROA"
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <ROAForm item={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
