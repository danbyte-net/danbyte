import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type PowerFeed } from "@/lib/api"
import { PowerFeedForm } from "@/components/power-feed-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/power-feeds/$id_/edit")({
  component: EditPowerFeedPage,
})

function EditPowerFeedPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["power-feed", id],
    queryFn: () => api<PowerFeed>(`/api/power-feeds/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Power feeds", to: "/power-feeds" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit power feed"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PowerFeedForm
          feed={q.data}
          onSaved={() => nav({ to: "/power-feeds" })}
          onCancel={() => nav({ to: "/power-feeds" })}
        />
      )}
    </EditPageShell>
  )
}
