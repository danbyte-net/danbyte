import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ApplicationGroupForm } from "@/components/application-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/application-groups/new")({
  component: NewApplicationGroupPage,
})

function NewApplicationGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Application groups", to: "/application-groups" },
        { label: "Add" },
      ]}
      title="Add application group"
    >
      <ApplicationGroupForm
        onSaved={(g) =>
          nav({ to: "/application-groups/$id", params: { id: g.id } })
        }
        onCancel={() => nav({ to: "/application-groups" })}
      />
    </EditPageShell>
  )
}
