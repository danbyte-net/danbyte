import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { BFDProfile } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { BFDProfileForm } from "@/components/routing/object-forms"
import { bfdProfileDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/bfd-profiles/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [bfdProfileDetail.queryKey, id],
    queryFn: () => api<BFDProfile>(`${bfdProfileDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/bfd-profiles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "BFD profiles", to: "/bfd-profiles" },
        { label: q.data ? bfdProfileDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit BFD profile"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <BFDProfileForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
