import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ApiError, api, apiErrorMessage } from "@/lib/api"
import type { CabinetType } from "@/lib/api"
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

export interface CabinetTypeDeleteDialogProps {
  cabinetType: CabinetType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

/** A type in use can't be deleted: the server answers 409 with how many
 * cabinets use it. The dialog says so up front from the type's count, and
 * shows the server's answer when cabinets took the type after it loaded. */
export function CabinetTypeDeleteDialog({
  cabinetType,
  onOpenChange,
  onDeleted,
}: CabinetTypeDeleteDialogProps) {
  const qc = useQueryClient()
  // Kept per type, so the dialog opened on another one starts clean.
  const [refused, setRefused] = useState<{ id: string; detail: string }>()
  const m = useMutation({
    mutationFn: (target: CabinetType) =>
      api<void>(`/api/cabinet-types/${target.id}/`, { method: "DELETE" }),
    onSuccess: (_, target) => {
      toast.success(`Deleted ${target.name}`)
      qc.invalidateQueries({ queryKey: ["cabinet-types"] })
      qc.invalidateQueries({ queryKey: ["cabinet-types-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err, target) => {
      if (err instanceof ApiError && err.status === 409) {
        setRefused({ id: target.id, detail: apiErrorMessage(err) })
        qc.invalidateQueries({ queryKey: ["cabinet-types"] })
        qc.invalidateQueries({ queryKey: ["cabinet-type", target.id] })
        return
      }
      apiErrorToast(err)
    },
  })

  const used = cabinetType?.cabinet_count ?? 0
  const inUse =
    cabinetType && refused?.id === cabinetType.id
      ? refused.detail
      : used > 0
        ? `${used} cabinet${used === 1 ? " uses" : "s use"} this type - unassign them first.`
        : null

  return (
    <AlertDialog open={!!cabinetType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {cabinetType?.name}?</AlertDialogTitle>
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
              if (cabinetType) m.mutate(cabinetType)
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
