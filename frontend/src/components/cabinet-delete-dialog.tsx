import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ApiError, api, apiErrorMessage } from "@/lib/api"
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

/** A cabinet with devices on its rails can't be deleted: the server answers
 * 409 with how many, and the dialog shows that and stays open. */
export function CabinetDeleteDialog({
  cabinet,
  onOpenChange,
  onDeleted,
}: CabinetDeleteDialogProps) {
  const qc = useQueryClient()
  // Kept per cabinet, so the dialog opened on another one starts clean.
  const [refused, setRefused] = useState<{ id: string; detail: string }>()
  const m = useMutation({
    mutationFn: (target: Cabinet) =>
      api<void>(`/api/cabinets/${target.id}/`, { method: "DELETE" }),
    onSuccess: (_, target) => {
      toast.success(`Deleted ${target.name}`)
      invalidateCabinetViews(qc)
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err, target) => {
      if (err instanceof ApiError && err.status === 409) {
        setRefused({ id: target.id, detail: apiErrorMessage(err) })
        return
      }
      apiErrorToast(err)
    },
  })
  const inUse = cabinet && refused?.id === cabinet.id ? refused.detail : null

  return (
    <AlertDialog open={!!cabinet} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete cabinet {cabinet?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse ?? "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || !!inUse}
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
