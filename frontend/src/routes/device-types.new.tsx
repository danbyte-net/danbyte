import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { type DeviceType } from "@/lib/api"
import { DeviceTypeForm } from "@/components/device-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { useCloneSeed } from "@/lib/use-clone"

export const Route = createFileRoute("/device-types/new")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(typeof s.clone === "string" ? { clone: s.clone } : {}),
  }),
  component: NewDeviceTypePage,
})

function NewDeviceTypePage() {
  const { clone } = Route.useSearch()
  const nav = useNavigate()
  const cloneQ = useCloneSeed<Partial<DeviceType>>("device-types", clone)
  const cloning = !!clone
  return (
    <EditPageShell
      crumbs={[
        { label: "Device types", to: "/device-types" },
        { label: cloning ? "Clone" : "Add" },
      ]}
      title={cloning ? "Clone device type" : "Add device type"}
      subtitle={
        cloning
          ? "Physical spec carried over - pick a new model name. Faceplate and images are not copied."
          : "A device template - manufacturer, model, and rack height."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <DeviceTypeForm
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(d) =>
            nav({ to: "/device-types/$id", params: { id: d.id } })
          }
          onCancel={() => nav({ to: "/device-types" })}
        />
      )}
    </EditPageShell>
  )
}
