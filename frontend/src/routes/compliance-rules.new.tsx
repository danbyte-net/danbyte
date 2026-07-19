import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { ComplianceRuleForm } from "@/components/compliance/rule-form"

export const Route = createFileRoute("/compliance-rules/new")({
  component: NewRulePage,
})

function NewRulePage() {
  const nav = useNavigate()
  const back = () => nav({ to: "/compliance", search: { tab: "rules" } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Compliance", to: "/compliance" },
        { label: "New rule" },
      ]}
      title="New compliance rule"
      subtitle="Assert a property over your data."
    >
      <ComplianceRuleForm onSaved={back} onCancel={back} />
    </EditPageShell>
  )
}
