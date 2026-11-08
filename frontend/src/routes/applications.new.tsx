import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ApplicationForm } from "@/components/application-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/applications/new")({
  component: NewApplicationPage,
})

function NewApplicationPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Applications", to: "/applications" },
        { label: "Add" },
      ]}
      title="Add application"
    >
      <ApplicationForm
        onSaved={(a) => nav({ to: "/applications/$id", params: { id: a.id } })}
        onCancel={() => nav({ to: "/applications" })}
      />
    </EditPageShell>
  )
}
