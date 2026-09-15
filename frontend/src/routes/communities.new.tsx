import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { CommunityForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/communities/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Communities", to: "/communities" }, { label: "Add" }]}
      title="Add community"
      subtitle="A BGP community value with a name."
    >
      <CommunityForm
        onSaved={(v) => nav({ to: "/communities/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/communities" })}
      />
    </EditPageShell>
  )
}
