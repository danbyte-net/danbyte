import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { PermissionForm } from "@/components/permission-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/permissions/new")({
  component: NewPermissionPage,
})

function NewPermissionPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Permissions", to: "/permissions" }, { label: "Add" }]}
      title="Add permission"
      subtitle="Grant actions on object types to groups or users, optionally scoped by tenant and constraints."
    >
      <PermissionForm
        onSaved={() => nav({ to: "/permissions" })}
        onCancel={() => nav({ to: "/permissions" })}
      />
    </EditPageShell>
  )
}
