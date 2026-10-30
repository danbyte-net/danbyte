import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, ChevronRight, Waypoints } from "lucide-react"
import { useState } from "react"

import { api } from "@/lib/api"
import type { Device, FloorPlanTile, Paginated, Rack } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ColorBadge } from "@/components/cells/color-badge"
import { CapacityBar } from "@/components/cells/capacity-bar"
import { PowerFigure } from "@/components/cells/power-figure"
import { DeviceMiniTopology } from "@/components/device-mini-topology"
import { BarTip } from "@/components/map-toolbar"
import { shownLink } from "./shown-link"
import { OpenLink } from "@/components/open-link"
import { QueryError } from "@/components/query-error"
import { RackElevation } from "@/components/rack-elevation"
import { capacityRatio, hasPowerData } from "@/lib/rack-capacity"
import { cn } from "@/lib/utils"

/** The contents + end-to-end trace sheet for a rack- or device-linked tile:
 * rack → capacity + the real elevation + its devices, each traceable;
 * device → its end-to-end paths (DeviceMiniTopology). */
export function DeepViewSheet({
  tile,
  onClose,
  onTraceCables,
}: {
  tile: FloorPlanTile | null
  onClose: () => void
  onTraceCables: (cableIds: string[]) => void
}) {
  const linked = shownLink(tile?.linked)
  return (
    <Sheet open={!!linked} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        // The default sm:max-w-sm is keyed on data-[side=right], so the
        // override must use the same variant to win the merge.
        className="w-full overflow-y-auto data-[side=right]:sm:max-w-3xl"
      >
        {linked?.kind === "rack" && (
          <RackDeepView rackId={linked.id} onTraceCables={onTraceCables} />
        )}
        {linked?.kind === "device" && (
          <DeviceDeepView
            deviceId={linked.id}
            name={linked.name}
            onTraceCables={onTraceCables}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function RackDeepView({
  rackId,
  onTraceCables,
}: {
  rackId: string
  onTraceCables: (cableIds: string[]) => void
}) {
  const rackQ = useQuery({
    queryKey: ["rack", rackId],
    queryFn: () => api<Rack>(`/api/racks/${rackId}/`),
  })
  const devicesQ = useQuery({
    queryKey: ["rack-devices", rackId],
    queryFn: () =>
      api<Paginated<Device>>(`/api/devices/?rack=${rackId}&page_size=500`),
  })
  const [traceDevice, setTraceDevice] = useState<Device | null>(null)
  const [showElevation, setShowElevation] = useState(false)

  const rack = rackQ.data
  const devices = [...(devicesQ.data?.results ?? [])].sort(
    (a, b) => (b.position ?? -1) - (a.position ?? -1)
  )

  if (traceDevice)
    return (
      <div className="flex h-full flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 px-1.5"
              onClick={() => setTraceDevice(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            {traceDevice.name}
          </SheetTitle>
          <SheetDescription>
            End-to-end cable paths from this device.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 px-4 pb-4">
          <DeviceMiniTopology
            deviceId={traceDevice.id}
            onTraceCables={onTraceCables}
          />
        </div>
      </div>
    )

  const utilization = rack
    ? capacityRatio(rack.used_units, rack.u_height)
    : null

  return (
    <div className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>{rack?.name ?? "Rack"}</SheetTitle>
        <SheetDescription>
          {rack && (
            <>
              <span className="num">
                {rack.used_units}/{rack.u_height}U used
              </span>
              {" · "}
              {hasPowerData(rack.power) && (
                <>
                  <PowerFigure power={rack.power} />
                  {" · "}
                </>
              )}
              <span className="num">{rack.device_count}</span> device
              {rack.device_count === 1 ? "" : "s"}
            </>
          )}
        </SheetDescription>
      </SheetHeader>
      <div className="grid gap-4 px-4 pb-4">
        {rackQ.isError && <QueryError error={rackQ.error} />}
        {utilization !== null && (
          <CapacityBar ratio={utilization} className="w-full" />
        )}
        {rack && (
          <OpenLink to="/racks/$id" params={{ id: rack.id }} className="w-fit">
            Open rack
          </OpenLink>
        )}
        {rack && (
          <div>
            <button
              type="button"
              onClick={() => setShowElevation((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  showElevation && "rotate-90"
                )}
              />
              Elevation
            </button>
            {showElevation && (
              <div className="mt-2">
                <RackElevation rack={rack} />
              </div>
            )}
          </div>
        )}
        <div>
          <p className="mb-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Devices
          </p>
          {devices.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing racked here yet.
            </p>
          )}
          <ul className="divide-y divide-border text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 py-1.5">
                <span className="num w-10 shrink-0 text-[11px] text-muted-foreground">
                  {d.position !== null ? `U${d.position}` : "-"}
                </span>
                <Link
                  to="/devices/$id"
                  params={{ id: d.id }}
                  className="link min-w-0 truncate font-medium"
                >
                  {d.name}
                </Link>
                {d.role && (
                  <ColorBadge
                    name={d.role.name}
                    color={d.role.color || undefined}
                    className="h-4 min-w-0 px-1.5 text-[10px]"
                  />
                )}
                <BarTip tip="Trace">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto size-7"
                    aria-label={`Trace ${d.name}`}
                    onClick={() => setTraceDevice(d)}
                  >
                    <Waypoints className="size-3.5" />
                  </Button>
                </BarTip>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function DeviceDeepView({
  deviceId,
  name,
  onTraceCables,
}: {
  deviceId: string
  name: string
  onTraceCables: (cableIds: string[]) => void
}) {
  return (
    <div className="flex flex-col">
      <SheetHeader>
        <SheetTitle>{name || "Device"}</SheetTitle>
        <SheetDescription>
          End-to-end cable paths from this device. Trace a whole run, or the{" "}
          <Waypoints className="inline h-3 w-3" /> on one cable, on the plan.
        </SheetDescription>
      </SheetHeader>
      {/* Natural top-aligned stack - no flex-1 stretch, so the button sits
          right above the topology instead of leaving a tall gap. */}
      <div className="flex flex-col gap-3 px-4 pb-4">
        <OpenLink to="/devices/$id" params={{ id: deviceId }} className="w-fit">
          Open device
        </OpenLink>
        <DeviceMiniTopology deviceId={deviceId} onTraceCables={onTraceCables} />
      </div>
    </div>
  )
}
