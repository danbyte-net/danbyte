import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ApplicationGroup } from "@/lib/api"
import { ApplicationGroupForm } from "@/components/application-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/application-groups/$id_/edit")({
  component: EditApplicationGroupPage,
})

function EditApplicationGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["application-group", id],
    queryFn: () => api<ApplicationGroup>(`/api/application-groups/${id}/`),
  })
  const back = () => nav({ to: "/application-groups/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Application groups", to: "/application-groups" },
        q.data
          ? {
              label: q.data.name,
              to: "/application-groups/$id",
              params: { id },
            }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit application group"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ApplicationGroupForm group={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
