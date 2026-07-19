import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { DeviceRoleForm } from "@/components/device-role-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/device-roles/new")({
  component: NewDeviceRolePage,
})

function NewDeviceRolePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Device roles", to: "/device-roles" },
        { label: "Add" },
      ]}
      title="Add device role"
      subtitle="A functional role a device or VM can play (core switch, hypervisor, …)."
    >
      <DeviceRoleForm
        onSaved={(r) => nav({ to: "/device-roles/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/device-roles" })}
      />
    </EditPageShell>
  )
}
