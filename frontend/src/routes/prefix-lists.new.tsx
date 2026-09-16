import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { PrefixListForm } from "@/components/routing/list-forms"

export const Route = createFileRoute("/prefix-lists/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Prefix lists", to: "/prefix-lists" },
        { label: "Add" },
      ]}
      title="Add prefix list"
      subtitle="A named set of prefixes a policy matches on."
    >
      <PrefixListForm
        onSaved={(v) => nav({ to: "/prefix-lists/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/prefix-lists" })}
      />
    </EditPageShell>
  )
}
