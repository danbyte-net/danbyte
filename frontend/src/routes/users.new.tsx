import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { UserForm } from "@/components/user-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/users/new")({ component: NewUserPage })

function NewUserPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Users", to: "/users" }, { label: "Add" }]}
      title="Add user"
      subtitle="Create a local or LDAP account and assign groups + tenant scope."
    >
      <UserForm
        onSaved={() => nav({ to: "/users" })}
        onCancel={() => nav({ to: "/users" })}
      />
    </EditPageShell>
  )
}
