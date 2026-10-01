import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Cabinet } from "@/lib/api"
import { invalidateCabinetViews } from "@/lib/cabinets"
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

export interface CabinetDeleteDialogProps {
  cabinet: Cabinet | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function CabinetDeleteDialog({
  cabinet,
  onOpenChange,
  onDeleted,
}: CabinetDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (target: Cabinet) =>
      api<void>(`/api/cabinets/${target.id}/`, { method: "DELETE" }),
    onSuccess: (_, target) => {
      toast.success(`Deleted ${target.name}`)
      invalidateCabinetViews(qc)
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!cabinet} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete cabinet {cabinet?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              if (cabinet) m.mutate(cabinet)
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
