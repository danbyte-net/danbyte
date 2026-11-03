import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RPKICache } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { RPKICacheForm } from "@/components/routing/object-forms"
import { rpkiCacheDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/rpki-caches/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [rpkiCacheDetail.queryKey, id],
    queryFn: () => api<RPKICache>(`${rpkiCacheDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/rpki-caches/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "RPKI caches", to: "/rpki-caches" },
        { label: q.data ? rpkiCacheDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit RPKI cache"
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <RPKICacheForm item={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
