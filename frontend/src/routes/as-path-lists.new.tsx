import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { ASPathListForm } from "@/components/routing/list-forms"

export const Route = createFileRoute("/as-path-lists/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "AS-path lists", to: "/as-path-lists" },
        { label: "Add" },
      ]}
      title="Add AS-path list"
      subtitle="Patterns over the AS path a policy matches on."
    >
      <ASPathListForm
        onSaved={(v) => nav({ to: "/as-path-lists/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/as-path-lists" })}
      />
    </EditPageShell>
  )
}
