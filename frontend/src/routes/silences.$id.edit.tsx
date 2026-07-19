import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Silence } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { SilenceForm } from "@/components/monitoring/silence-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/silences/$id/edit")({
  component: EditSilencePage,
})

function EditSilencePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const back = () =>
    nav({
      to: "/alerts",
      search: { tab: "silences", state: "firing", severity: "all" },
    })

  const q = useQuery({
    queryKey: ["silence", id],
    queryFn: () => api<Silence>(`/api/monitoring/silences/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[{ label: "Alerts", to: "/alerts" }, { label: "Edit silence" }]}
      title="Edit silence"
    >
      {q.isError && <QueryError error={q.error} />}
      {q.data ? (
        <SilenceForm silence={q.data} onSaved={back} onCancel={back} />
      ) : (
        !q.isError && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </EditPageShell>
  )
}
