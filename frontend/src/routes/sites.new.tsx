import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { SiteForm } from "@/components/site-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/sites/new")({
  component: NewSitePage,
})

function NewSitePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Sites", to: "/sites" }, { label: "Add" }]}
      title="Add site"
      subtitle="Register a new physical location."
    >
      <SiteForm
        onSaved={(s) => nav({ to: "/sites/$id", params: { id: s.id } })}
        onCancel={() => nav({ to: "/sites" })}
      />
    </EditPageShell>
  )
}
