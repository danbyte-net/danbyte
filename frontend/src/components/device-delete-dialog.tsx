import { useCallback, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Device, PrtgDeleteResult } from "@/lib/api"
import { invalidateCabinetDeviceViews } from "@/lib/cabinets"
import { invalidatePortCounts } from "@/lib/port-utilization"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { apiErrorToast } from "@/lib/api-toast"
import {
  KEEP_IN_PRTG,
  PrtgDeleteOption,
  prtgDeleteQuery,
  prtgDeleteToast,
} from "@/components/prtg/delete-option"
import type { PrtgDeleteChoice } from "@/components/prtg/delete-option"

export interface DeviceDeleteDialogProps {
  device: Device | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function DeviceDeleteDialog({
  device,
  onOpenChange,
  onDeleted,
}: DeviceDeleteDialogProps) {
  const qc = useQueryClient()
  const [prtg, setPrtg] = useState<PrtgDeleteChoice>(KEEP_IN_PRTG)
  const [prtgReady, setPrtgReady] = useState(true)
  const onPrtg = useCallback((c: PrtgDeleteChoice, ready: boolean) => {
    setPrtg(c)
    setPrtgReady(ready)
  }, [])
  const m = useMutation({
    mutationFn: () =>
      api<{ prtg?: PrtgDeleteResult[] } | undefined>(
        `/api/devices/${device!.id}/${prtgDeleteQuery(prtg)}`,
        { method: "DELETE" }
      ),
    onSuccess: (res) => {
      toast.success(`Deleted ${device!.name}`)
      prtgDeleteToast(res?.prtg)
      qc.invalidateQueries({ queryKey: ["prtg-links"] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["devices-picker"] })
      // Its cables go with it, freeing the ports at their far ends.
      invalidatePortCounts(qc)
      // A device on a rail leaves a gap in its cabinet's drawing.
      if (device!.cabinet) invalidateCabinetDeviceViews(qc)
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const ips = device?.ip_count ?? 0
  return (
    <AlertDialog open={!!device} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {device?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {ips > 0
              ? `${ips} IP${ips === 1 ? "" : "s"} are assigned to this device - they'll be unassigned. Interfaces are removed.`
              : "This also removes its interfaces. This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <PrtgDeleteOption
          key={device?.id}
          parent={device ? { device: device.id } : null}
          onChange={onPrtg}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || !prtgReady}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
