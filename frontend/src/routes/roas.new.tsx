import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { ROAForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/roas/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "ROAs", to: "/roas" }, { label: "Add" }]}
      title="Add ROA"
      subtitle="A prefix, its max length and the AS that may originate it."
    >
      <ROAForm
        onSaved={(v) => nav({ to: "/roas/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/roas" })}
      />
    </EditPageShell>
  )
}
