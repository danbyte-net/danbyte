import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DeviceType } from "@/lib/api"
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

export interface DeviceTypeDeleteDialogProps {
  deviceType: DeviceType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function DeviceTypeDeleteDialog({
  deviceType,
  onOpenChange,
  onDeleted,
}: DeviceTypeDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/device-types/${deviceType!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${deviceType!.name}`)
      qc.invalidateQueries({ queryKey: ["device-types"] })
      qc.invalidateQueries({ queryKey: ["device-types-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const n = deviceType?.device_count ?? 0
  return (
    <AlertDialog open={!!deviceType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {deviceType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {n > 0
              ? `${n} device${n === 1 ? "" : "s"} use this type — they'll keep working but lose their type reference.`
              : "This action can't be undone."}
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
