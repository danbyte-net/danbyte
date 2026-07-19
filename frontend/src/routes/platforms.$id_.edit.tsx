import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Platform } from "@/lib/api"
import { PlatformForm } from "@/components/platform-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/platforms/$id_/edit")({
  component: EditPlatformPage,
})

function EditPlatformPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["platform", id],
    queryFn: () => api<Platform>(`/api/platforms/${id}/`),
  })
  const back = () => nav({ to: "/platforms/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Platforms", to: "/platforms" },
        q.data
          ? { label: q.data.name, to: "/platforms/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit platform"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PlatformForm platform={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
