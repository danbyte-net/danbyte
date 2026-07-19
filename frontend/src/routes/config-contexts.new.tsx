import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ConfigContextForm } from "@/components/config-context-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/config-contexts/new")({
  component: NewConfigContextPage,
})

function NewConfigContextPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Config contexts", to: "/config-contexts" },
        { label: "Add" },
      ]}
      title="Add config context"
      subtitle="JSON data merged onto devices/VMs that match the criteria."
    >
      <ConfigContextForm
        onSaved={() => nav({ to: "/config-contexts" })}
        onCancel={() => nav({ to: "/config-contexts" })}
      />
    </EditPageShell>
  )
}
