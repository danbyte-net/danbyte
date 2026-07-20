import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { RuleForm } from "@/components/monitoring/rule-form"

export const Route = createFileRoute("/alert-rules/new")({
  component: NewRulePage,
})

function NewRulePage() {
  const nav = useNavigate()
  const back = () =>
    nav({
      to: "/alerts",
      search: { tab: "rules", state: "firing", severity: "all", ack: "all", q: "", site: "all" },
    })
  return (
    <EditPageShell
      crumbs={[{ label: "Alerts", to: "/alerts" }, { label: "New rule" }]}
      title="New alert rule"
      subtitle="Decide which check failures alert, and at what severity."
    >
      <RuleForm onSaved={back} onCancel={back} />
    </EditPageShell>
  )
}
