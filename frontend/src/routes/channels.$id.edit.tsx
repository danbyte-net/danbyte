import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type NotificationChannel } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { ChannelForm } from "@/components/monitoring/channel-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/channels/$id/edit")({
  component: EditChannelPage,
})

function EditChannelPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const back = () =>
    nav({
      to: "/alerts",
      search: { tab: "channels", state: "firing", severity: "all" },
    })

  const q = useQuery({
    queryKey: ["channel", id],
    queryFn: () => api<NotificationChannel>(`/api/monitoring/channels/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[{ label: "Alerts", to: "/alerts" }, { label: "Edit channel" }]}
      title="Edit notification channel"
    >
      {q.isError && <QueryError error={q.error} />}
      {q.data ? (
        <ChannelForm channel={q.data} onSaved={back} onCancel={back} />
      ) : (
        !q.isError && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </EditPageShell>
  )
}
