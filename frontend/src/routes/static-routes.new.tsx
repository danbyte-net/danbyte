import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { StaticRouteForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/static-routes/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Static routes", to: "/static-routes" },
        { label: "Add" },
      ]}
      title="Add static route"
      subtitle="One path on one device: a prefix, the table it sits in, and where it goes."
    >
      <StaticRouteForm
        onSaved={(v) => nav({ to: "/static-routes/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/static-routes" })}
      />
    </EditPageShell>
  )
}
