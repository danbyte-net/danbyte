import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RackRoleForm } from "@/components/rack-role-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/rack-roles/new")({
  component: NewRackRolePage,
})

function NewRackRolePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Rack roles", to: "/rack-roles" }, { label: "Add" }]}
      title="Add rack role"
      subtitle="A functional role a rack can play (compute, storage, network, …)."
    >
      <RackRoleForm
        onSaved={(r) => nav({ to: "/rack-roles/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/rack-roles" })}
      />
    </EditPageShell>
  )
}
