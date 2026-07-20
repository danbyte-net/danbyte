import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type AlertRule } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { RuleForm } from "@/components/monitoring/rule-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/alert-rules/$id/edit")({
  component: EditRulePage,
})

function EditRulePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const back = () =>
    nav({
      to: "/alerts",
      search: { tab: "rules", state: "firing", severity: "all", ack: "all", q: "", site: "all" },
    })

  const q = useQuery({
    queryKey: ["alert-rule", id],
    queryFn: () => api<AlertRule>(`/api/monitoring/alert-rules/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[{ label: "Alerts", to: "/alerts" }, { label: "Edit rule" }]}
      title="Edit alert rule"
    >
      {q.isError && <QueryError error={q.error} />}
      {q.data ? (
        <RuleForm rule={q.data} onSaved={back} onCancel={back} />
      ) : (
        !q.isError && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </EditPageShell>
  )
}
