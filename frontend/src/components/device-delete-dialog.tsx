import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Device } from "@/lib/api"
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
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/devices/${device!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${device!.name}`)
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["devices-picker"] })
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
              ? `${ips} IP${ips === 1 ? "" : "s"} are assigned to this device — they'll be unassigned. Interfaces are removed.`
              : "This also removes its interfaces. This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
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
