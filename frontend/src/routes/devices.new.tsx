import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { DeviceForm } from "@/components/device-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Spinner } from "@/components/ui/spinner"
import type { Device } from "@/lib/api"
import { useCloneSeed } from "@/lib/use-clone"

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
    clone?: string
  } => ({
    ...(typeof s.rack === "string" ? { rack: s.rack } : {}),
    ...(typeof s.position === "number" || typeof s.position === "string"
      ? { position: Number(s.position) }
      : {}),
    ...(s.face === "front" || s.face === "rear" ? { face: s.face } : {}),
    ...(typeof s.clone === "string" ? { clone: s.clone } : {}),
  }),
})

function NewDevicePage() {
  const nav = useNavigate()
  const { rack, position, face, clone } = Route.useSearch()
  const cloneQ = useCloneSeed<Partial<Device>>("devices", clone)
  const cloning = !!clone

  return (
    <EditPageShell
      crumbs={[
        { label: "Devices", to: "/devices" },
        { label: cloning ? "Clone" : "Add" },
      ]}
      title={cloning ? "Clone device" : "Add device"}
      subtitle={
        cloning
          ? "Pre-filled from an existing device — give it a new name, serial, and rack placement."
          : "A physical device — its type, site, and status."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading source device…
        </div>
      ) : (
        <DeviceForm
          initial={rack ? { rackId: rack, position, face } : undefined}
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(d) => nav({ to: "/devices/$id", params: { id: d.id } })}
          onCancel={() => nav({ to: "/devices" })}
        />
      )}
    </EditPageShell>
  )
}
