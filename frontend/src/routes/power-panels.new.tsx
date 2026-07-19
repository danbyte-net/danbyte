import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { PowerPanelForm } from "@/components/power-panel-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/power-panels/new")({
  component: NewPowerPanelPage,
})

function NewPowerPanelPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Power panels", to: "/power-panels" },
        { label: "Add" },
      ]}
      title="Add power panel"
      subtitle="A distribution panel within a site."
    >
      <PowerPanelForm
        onSaved={() => nav({ to: "/power-panels" })}
        onCancel={() => nav({ to: "/power-panels" })}
      />
    </EditPageShell>
  )
}
