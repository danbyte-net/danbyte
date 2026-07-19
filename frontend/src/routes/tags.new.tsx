import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { TagForm } from "@/components/tag-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/tags/new")({ component: NewTagPage })

function NewTagPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Tags", to: "/tags" }, { label: "Add" }]}
      title="Add tag"
      subtitle="A reusable label, optionally colored, that you can attach to any object."
    >
      <TagForm
        onSaved={(t) => nav({ to: "/tags/$id", params: { id: String(t.id) } })}
        onCancel={() => nav({ to: "/tags" })}
      />
    </EditPageShell>
  )
}
