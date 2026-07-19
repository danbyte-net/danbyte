import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { InterfaceForm } from "@/components/interface-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/interfaces/new")({
  component: NewInterfacePage,
  validateSearch: (s: Record<string, unknown>): { device?: string } =>
    typeof s.device === "string" ? { device: s.device } : {},
})

function NewInterfacePage() {
  const nav = useNavigate()
  const { device } = Route.useSearch()
  return (
    <EditPageShell
      crumbs={[{ label: "Interfaces", to: "/interfaces" }, { label: "Add" }]}
      title="Add interface"
      subtitle="A network interface (port) on a device."
    >
      <InterfaceForm
        initialDeviceId={device}
        onSaved={(i) => nav({ to: "/interfaces/$id", params: { id: i.id } })}
        onCancel={() => nav({ to: "/interfaces" })}
      />
    </EditPageShell>
  )
}
