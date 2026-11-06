import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { SensitivityLabel } from "@/lib/api"
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
import { SENSITIVITY_LABEL_KEYS } from "@/components/sensitivity-label-form"

export function SensitivityLabelDeleteDialog({
  label,
  onOpenChange,
  onDeleted,
}: {
  label: SensitivityLabel | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/sensitivity-labels/${label!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${label!.name}`)
      for (const queryKey of SENSITIVITY_LABEL_KEYS)
        qc.invalidateQueries({ queryKey })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!label} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {label?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {label?.is_default
              ? "New reports will start without a label. Reports already made keep theirs."
              : "Reports already made keep their marking. This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
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
