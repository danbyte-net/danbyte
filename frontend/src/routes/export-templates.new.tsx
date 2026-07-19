import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ExportTemplateForm } from "@/components/export-template-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/export-templates/new")({
  component: NewExportTemplatePage,
})

function NewExportTemplatePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Export templates", to: "/export-templates" },
        { label: "Add" },
      ]}
      title="Add export template"
      subtitle="A Jinja2 template that renders objects of one type to a file."
    >
      <ExportTemplateForm
        onSaved={() => nav({ to: "/export-templates" })}
        onCancel={() => nav({ to: "/export-templates" })}
      />
    </EditPageShell>
  )
}
