import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { ChannelForm } from "@/components/monitoring/channel-form"

export const Route = createFileRoute("/channels/new")({
  component: NewChannelPage,
})

function NewChannelPage() {
  const nav = useNavigate()
  const back = () =>
    nav({
      to: "/alerts",
      search: { tab: "channels", state: "firing", severity: "all", ack: "all", q: "", site: "all" },
    })
  return (
    <EditPageShell
      crumbs={[{ label: "Alerts", to: "/alerts" }, { label: "New channel" }]}
      title="New notification channel"
      subtitle="Where alerts are delivered."
    >
      <ChannelForm onSaved={back} onCancel={back} />
    </EditPageShell>
  )
}
