import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { PrefixList } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { PrefixListForm } from "@/components/routing/list-forms"
import { prefixListDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/prefix-lists/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [prefixListDetail.queryKey, id],
    queryFn: () => api<PrefixList>(`${prefixListDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/prefix-lists/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Prefix lists", to: "/prefix-lists" },
        { label: q.data ? prefixListDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit prefix list"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PrefixListForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
