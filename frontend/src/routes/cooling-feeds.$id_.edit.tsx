import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { CoolingFeed } from "@/lib/api"
import { CoolingFeedForm } from "@/components/cooling-feed-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/cooling-feeds/$id_/edit")({
  component: EditCoolingFeedPage,
})

function EditCoolingFeedPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cooling-feed", id],
    queryFn: () => api<CoolingFeed>(`/api/cooling-feeds/${id}/`),
  })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cooling feeds", to: "/cooling-feeds" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit cooling feed"
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <CoolingFeedForm
          feed={q.data}
          onSaved={() => nav({ to: "/cooling-feeds/$id", params: { id } })}
          onCancel={() => nav({ to: "/cooling-feeds/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
