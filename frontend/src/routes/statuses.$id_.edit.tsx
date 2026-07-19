import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Status } from "@/lib/api"
import { IpStatusForm } from "@/components/ip-status-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/statuses/$id_/edit")({
  component: EditIpStatusPage,
})

function EditIpStatusPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["ip-status", id],
    queryFn: () => api<Status>(`/api/statuses/${id}/`),
  })
  const back = () => nav({ to: "/statuses/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Statuses", to: "/statuses" },
        q.data
          ? { label: q.data.name, to: "/statuses/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit status"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <IpStatusForm status={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
