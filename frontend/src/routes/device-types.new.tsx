import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { DeviceTypeForm } from "@/components/device-type-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/device-types/new")({
  component: NewDeviceTypePage,
})

function NewDeviceTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Device types", to: "/device-types" },
        { label: "Add" },
      ]}
      title="Add device type"
      subtitle="A device template — manufacturer, model, and rack height."
    >
      <DeviceTypeForm
        onSaved={(d) => nav({ to: "/device-types/$id", params: { id: d.id } })}
        onCancel={() => nav({ to: "/device-types" })}
      />
    </EditPageShell>
  )
}
