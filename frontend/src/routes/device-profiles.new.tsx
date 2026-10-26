import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { DeviceProfileForm } from "@/components/device-profile-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/device-profiles/new")({
  component: NewDeviceProfilePage,
})

function NewDeviceProfilePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Device profiles", to: "/device-profiles" },
        { label: "Add" },
      ]}
      title="Add device profile"
    >
      <DeviceProfileForm
        onSaved={(p) =>
          nav({ to: "/device-profiles/$id", params: { id: p.id } })
        }
        onCancel={() => nav({ to: "/device-profiles" })}
      />
    </EditPageShell>
  )
}
