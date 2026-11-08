import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { DeployPipelineEditor } from "@/components/deploy-pipeline-editor"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/pipelines/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Pipelines", to: "/pipelines" }, { label: "New" }]}
      title="New pipeline"
      wide
    >
      <DeployPipelineEditor
        onSaved={(p) => nav({ to: "/pipelines/$id", params: { id: p.id } })}
        onCancel={() => nav({ to: "/pipelines" })}
      />
    </EditPageShell>
  )
}
