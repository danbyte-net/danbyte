import { createFileRoute } from "@tanstack/react-router"

import { AutomationTargetWizard } from "@/components/automation-target-wizard"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/automation-targets/setup")({
  component: SetupPage,
})

function SetupPage() {
  return (
    <EditPageShell
      crumbs={[
        { label: "Automation targets", to: "/automation-targets" },
        { label: "Guided setup" },
      ]}
      title="Connect your automation"
      subtitle="Point Danbyte at the system that runs your playbooks. Danbyte hands off the work — it never touches your devices."
    >
      <AutomationTargetWizard />
    </EditPageShell>
  )
}
