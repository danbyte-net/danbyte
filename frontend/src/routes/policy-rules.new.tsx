import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { PolicyRuleForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/policy-rules/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Policy rules", to: "/policy-rules" },
        { label: "Add" },
      ]}
      title="Add policy rule"
      subtitle="One ip rule on one device or VM: what it matches and the table it looks up."
    >
      <PolicyRuleForm
        onSaved={(v) => nav({ to: "/policy-rules/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/policy-rules" })}
      />
    </EditPageShell>
  )
}
