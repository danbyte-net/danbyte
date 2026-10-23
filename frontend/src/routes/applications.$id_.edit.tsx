import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Application } from "@/lib/api"
import { ApplicationForm } from "@/components/application-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/applications/$id_/edit")({
  component: EditApplicationPage,
})

function EditApplicationPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["application", id],
    queryFn: () => api<Application>(`/api/applications/${id}/`),
  })
  const back = () => nav({ to: "/applications/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Applications", to: "/applications" },
        q.data
          ? { label: q.data.name, to: "/applications/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit application"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ApplicationForm application={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
