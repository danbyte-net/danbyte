import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ComplianceRule } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { ComplianceRuleForm } from "@/components/compliance/rule-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/compliance-rules/$id/edit")({
  component: EditRulePage,
})

function EditRulePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const back = () => nav({ to: "/compliance", search: { tab: "rules" } })

  const q = useQuery({
    queryKey: ["compliance-rule", id],
    queryFn: () => api<ComplianceRule>(`/api/compliance-rules/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "Compliance", to: "/compliance" },
        { label: "Edit rule" },
      ]}
      title="Edit compliance rule"
    >
      {q.isError && <QueryError error={q.error} />}
      {q.data ? (
        <ComplianceRuleForm rule={q.data} onSaved={back} onCancel={back} />
      ) : (
        !q.isError && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </EditPageShell>
  )
}
