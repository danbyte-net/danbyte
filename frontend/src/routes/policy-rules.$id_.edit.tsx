import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { PolicyRule } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { PolicyRuleForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/policy-rules/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["policy-rule", id],
    queryFn: () => api<PolicyRule>(`/api/routing/ip-rules/${id}/`),
  })
  const back = () => nav({ to: "/policy-rules/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Policy rules", to: "/policy-rules" },
        { label: q.data ? `Rule ${q.data.priority}` : "…" },
        { label: "Edit" },
      ]}
      title="Edit policy rule"
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PolicyRuleForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
