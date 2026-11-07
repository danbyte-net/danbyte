import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeployPipeline } from "@/lib/api"
import { DeployPipelineEditor } from "@/components/deploy-pipeline-editor"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/pipelines/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["deploy-pipeline", id],
    queryFn: () => api<DeployPipeline>(`/api/deploy-pipelines/${id}/`),
  })
  const back = () => nav({ to: "/pipelines/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Pipelines", to: "/pipelines" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit pipeline"
      wide
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <DeployPipelineEditor
          pipeline={q.data}
          onSaved={back}
          onCancel={back}
        />
      )}
    </EditPageShell>
  )
}
