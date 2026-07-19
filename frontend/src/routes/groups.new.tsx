import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { GroupForm } from "@/components/group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/groups/new")({ component: NewGroupPage })

function NewGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Groups", to: "/groups" }, { label: "Add" }]}
      title="Add group"
      subtitle="A named set of users you can grant permissions to."
    >
      <GroupForm
        onSaved={() => nav({ to: "/groups" })}
        onCancel={() => nav({ to: "/groups" })}
      />
    </EditPageShell>
  )
}
