import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowDownToLine, ChevronDown, Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Cabinet, Device, DinRail } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { invalidateCabinetDeviceViews } from "@/lib/cabinets"
import {
  PROFILE_LABELS,
  fmtMm,
  freeGaps,
  railSpans,
  widestGap,
} from "@/lib/din-geometry"
import { invalidateObjectQueries } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import { DevicePicker } from "@/components/device-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Putting devices on a cabinet's rails, from its plate's heading: **Add
 * device** opens the new-device form on the picked rail, **Assign** puts an
 * existing device at the cabinet's site on it. Neither gives an offset, so
 * the device takes the first gap from the left it fits in; each rail says
 * how wide its widest gap is.
 */
export function CabinetRailActions({
  cabinet,
  devices,
}: {
  cabinet: Cabinet
  /** The devices in the cabinet, for the rails' free room. */
  devices: Device[]
}) {
  const { canDo } = useMe()
  const [assigning, setAssigning] = useState<DinRail | null>(null)
  const canAdd = canDo("device", "add")
  const canAssign = canDo("device", "change")
  if (cabinet.rails.length === 0 || (!canAdd && !canAssign)) return null

  const free = (r: DinRail) =>
    widestGap(
      freeGaps(
        r.length_mm,
        railSpans(devices.filter((d) => d.din_rail?.id === r.id))
      )
    )

  return (
    <>
      {canAdd && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="-my-1 h-6 px-2 text-xs"
            >
              <Plus className="h-3 w-3" /> Add device
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {cabinet.rails.map((r) => (
              <DropdownMenuItem key={r.id} asChild>
                <Link
                  to="/devices/new"
                  search={{
                    cabinet: cabinet.id,
                    din_rail: r.id,
                    site: cabinet.site.id,
                  }}
                >
                  <RailItem rail={r} free={free(r)} />
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canAssign && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="-my-1 h-6 px-2 text-xs"
            >
              <ArrowDownToLine className="h-3 w-3" /> Assign
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {cabinet.rails.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => setAssigning(r)}>
                <RailItem rail={r} free={free(r)} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AssignDeviceDialog
        // A fresh pick per rail.
        key={assigning?.id ?? "none"}
        cabinet={cabinet}
        rail={assigning}
        devices={devices}
        onClose={() => setAssigning(null)}
      />
    </>
  )
}

/** "R1  TS 35  405 mm free" - a rail as the menus list it. */
function RailItem({ rail, free }: { rail: DinRail; free: number }) {
  return (
    <>
      <span className="font-medium">{rail.label}</span>
      <span className="text-muted-foreground">
        {PROFILE_LABELS[rail.profile]}
      </span>
      <span className="num ml-auto text-xs text-muted-foreground">
        {free > 0 ? `${fmtMm(free)} mm free` : "Full"}
      </span>
    </>
  )
}

/** Put an existing device at the cabinet's site on `rail`: the server
 * takes the first gap it fits in, or says why not. */
function AssignDeviceDialog({
  cabinet,
  rail,
  devices,
  onClose,
}: {
  cabinet: Cabinet
  rail: DinRail | null
  devices: Device[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const assign = useMutation({
    mutationFn: ({ id, railId }: { id: string; railId: string }) =>
      api<Device>(`/api/devices/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ din_rail_id: railId }),
      }),
    onSuccess: (d) => {
      invalidateCabinetDeviceViews(qc)
      invalidateObjectQueries(qc, d.id)
      void qc.invalidateQueries({ queryKey: ["devices"] })
      toast.success(
        `${d.name} on ${d.din_rail?.label ?? rail?.label} at ${fmtMm(d.din_offset_mm ?? 0)} mm`
      )
      onClose()
    },
    onError: (err) => apiErrorToast(err),
  })
  // Already on this rail: nothing to assign.
  const here = devices
    .filter((d) => rail && d.din_rail?.id === rail.id)
    .map((d) => d.id)

  return (
    <Dialog
      open={!!rail}
      onOpenChange={(o) => !o && !assign.isPending && onClose()}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (rail && deviceId)
              assign.mutate({ id: deviceId, railId: rail.id })
          }}
        >
          <DialogHeader>
            <DialogTitle>Assign to {rail?.label}</DialogTitle>
          </DialogHeader>
          <DevicePicker
            siteId={cabinet.site.id}
            dinProfile={rail?.profile}
            value={deviceId}
            onChange={setDeviceId}
            excludeIds={here}
            placeholder="Select a device…"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={assign.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!deviceId || assign.isPending}>
              {assign.isPending ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
