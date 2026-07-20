import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { SilenceForm } from "@/components/monitoring/silence-form"

export const Route = createFileRoute("/silences/new")({
  component: NewSilencePage,
})

function NewSilencePage() {
  const nav = useNavigate()
  const back = () =>
    nav({
      to: "/alerts",
      search: { tab: "silences", state: "firing", severity: "all", ack: "all", q: "", site: "all" },
    })
  return (
    <EditPageShell
      crumbs={[{ label: "Alerts", to: "/alerts" }, { label: "New silence" }]}
      title="New silence / maintenance window"
      subtitle="Mute notifications for matching alerts during a time window."
    >
      <SilenceForm onSaved={back} onCancel={back} />
    </EditPageShell>
  )
}
