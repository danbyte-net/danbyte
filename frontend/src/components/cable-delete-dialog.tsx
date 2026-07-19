import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Cable } from "@/lib/api"
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

export interface CableDeleteDialogProps {
  cable: Cable | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function CableDeleteDialog({
  cable,
  onOpenChange,
  onDeleted,
}: CableDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/cables/${cable!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Cable deleted")
      qc.invalidateQueries({ queryKey: ["cables"] })
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!cable} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this cable?</AlertDialogTitle>
          <AlertDialogDescription>
            {cable && (
              <>
                {cable.a_terminations
                  .map((t) => `${t.device.name}:${t.name}`)
                  .join(", ") || "?"}{" "}
                ↔{" "}
                {cable.b_terminations
                  .map((t) => `${t.device.name}:${t.name}`)
                  .join(", ") || "?"}
                . This action can't be undone.
              </>
            )}
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
