import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type ExportTemplate } from "@/lib/api"
import { ExportTemplateForm } from "@/components/export-template-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/export-templates/$id_/edit")({
  component: EditExportTemplatePage,
})

function EditExportTemplatePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["export-template", id],
    queryFn: () => api<ExportTemplate>(`/api/export-templates/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Export templates", to: "/export-templates" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit export template"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ExportTemplateForm
          template={q.data}
          onSaved={() => nav({ to: "/export-templates" })}
          onCancel={() => nav({ to: "/export-templates" })}
        />
      )}
    </EditPageShell>
  )
}
