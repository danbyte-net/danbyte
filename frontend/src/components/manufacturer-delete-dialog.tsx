import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Manufacturer } from "@/lib/api"
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

export interface ManufacturerDeleteDialogProps {
  manufacturer: Manufacturer | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ManufacturerDeleteDialog({
  manufacturer,
  onOpenChange,
  onDeleted,
}: ManufacturerDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/manufacturers/${manufacturer!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${manufacturer!.name}`)
      qc.invalidateQueries({ queryKey: ["manufacturers"] })
      qc.invalidateQueries({ queryKey: ["manufacturers-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const inUse = (manufacturer?.device_type_count ?? 0) > 0
  return (
    <AlertDialog open={!!manufacturer} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {manufacturer?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `${manufacturer?.device_type_count} device type(s) reference this manufacturer — reassign or delete them first.`
              : "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending || inUse}
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
