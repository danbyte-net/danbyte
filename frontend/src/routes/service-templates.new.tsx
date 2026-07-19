import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ServiceTemplateForm } from "@/components/service-template-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/service-templates/new")({
  component: NewServiceTemplatePage,
})

function NewServiceTemplatePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Service templates", to: "/service-templates" },
        { label: "Add" },
      ]}
      title="Add service template"
      subtitle="A reusable service definition (protocol + ports) you can apply to devices and VMs."
    >
      <ServiceTemplateForm
        onSaved={(t) =>
          nav({ to: "/service-templates/$id", params: { id: t.id } })
        }
        onCancel={() => nav({ to: "/service-templates" })}
      />
    </EditPageShell>
  )
}
