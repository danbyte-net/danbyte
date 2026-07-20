import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type PlatformGroup } from "@/lib/api"
import { PlatformGroupForm } from "@/components/platform-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/platform-groups/$id_/edit")({
  component: EditPlatformGroupPage,
})

function EditPlatformGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["platform-group", id],
    queryFn: () => api<PlatformGroup>(`/api/platform-groups/${id}/`),
  })
  const back = () => nav({ to: "/platform-groups/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Platform groups", to: "/platform-groups" },
        q.data
          ? { label: q.data.name, to: "/platform-groups/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit platform group"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PlatformGroupForm group={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
