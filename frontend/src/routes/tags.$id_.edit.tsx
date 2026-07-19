import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Tag } from "@/lib/api"
import { TagForm } from "@/components/tag-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/tags/$id_/edit")({
  component: EditTagPage,
})

function EditTagPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["tag", id],
    queryFn: () => api<Tag>(`/api/tags/${id}/`),
  })
  const backToDetail = () => nav({ to: "/tags/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Tags", to: "/tags" },
        q.data
          ? { label: q.data.name, to: "/tags/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit tag"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <TagForm tag={q.data} onSaved={backToDetail} onCancel={backToDetail} />
      )}
    </EditPageShell>
  )
}
