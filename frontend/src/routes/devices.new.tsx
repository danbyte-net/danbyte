import { toast } from "sonner"
import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { DeviceForm } from "@/components/device-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Spinner } from "@/components/ui/spinner"
import type { Device } from "@/lib/api"
import { useCloneSeed } from "@/lib/use-clone"
import { planSearch, type PlanSearch } from "@/lib/save-object"

export const Route = createFileRoute("/devices/new")({
  component: NewDevicePage,
  // "+ Add here" on an empty rack unit arrives with placement pre-chosen;
  // "Clone" arrives with ?clone=<source id>.
  validateSearch: (
    s: Record<string, unknown>
  ): {
    rack?: string
    position?: number
    face?: "front" | "rear"
    mount?: "side_left" | "side_right"
    device_type?: string
    clone?: string
  } & PlanSearch => ({
    ...(typeof s.rack === "string" ? { rack: s.rack } : {}),
    ...(s.mount === "side_left" || s.mount === "side_right"
      ? { mount: s.mount }
      : {}),
    ...(typeof s.device_type === "string"
      ? { device_type: s.device_type }
      : {}),
    ...(typeof s.position === "number" || typeof s.position === "string"
      ? { position: Number(s.position) }
      : {}),
    ...(s.face === "front" || s.face === "rear" ? { face: s.face } : {}),
    ...(typeof s.clone === "string" ? { clone: s.clone } : {}),
    ...planSearch(s),
  }),
})

function NewDevicePage() {
  const nav = useNavigate()
  const { rack, position, face, mount, device_type, clone } = Route.useSearch()
  const cloneQ = useCloneSeed<Partial<Device>>("devices", clone)
  const cloning = !!clone

  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Devices", to: "/devices" },
        { label: cloning ? "Clone" : "Add" },
      ]}
      title={cloning ? "Clone device" : "Add device"}
      subtitle={
        cloning
          ? "Pre-filled from an existing device - give it a new name, serial, and rack placement."
          : "A physical device - its type, site, and status."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading source device…
        </div>
      ) : (
        <DeviceForm
          initial={
            rack || device_type
              ? {
                  rackId: rack,
                  position,
                  face,
                  mount,
                  deviceTypeId: device_type,
                }
              : undefined
          }
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(d) => {
            nav({ to: "/devices/$id", params: { id: d.id } })
            // The moment ports are wanted is right after creating the box.
            toast("Give it ports?", {
              action: {
                label: "Add interfaces",
                onClick: () =>
                  nav({ to: "/interfaces/bulk", search: { device: d.id } }),
              },
            })
          }}
          onCancel={() => nav({ to: "/devices" })}
        />
      )}
    </EditPageShell>
  )
}
