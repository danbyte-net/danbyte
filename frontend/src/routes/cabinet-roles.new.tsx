import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CabinetRoleForm } from "@/components/cabinet-role-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/cabinet-roles/new")({
  component: NewCabinetRolePage,
})

function NewCabinetRolePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Cabinet roles", to: "/cabinet-roles" },
        { label: "Add" },
      ]}
      title="Add cabinet role"
      subtitle="What a cabinet is for - distribution, control, metering, …"
    >
      <CabinetRoleForm
        onSaved={(r) => nav({ to: "/cabinet-roles/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/cabinet-roles" })}
      />
    </EditPageShell>
  )
}
