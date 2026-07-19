import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type RIR } from "@/lib/api"
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

export interface RirDeleteDialogProps {
  rir: RIR | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function RirDeleteDialog({
  rir,
  onOpenChange,
  onDeleted,
}: RirDeleteDialogProps) {
  const qc = useQueryClient()
  const blocked = !!rir && rir.aggregate_count > 0
  const m = useMutation({
    mutationFn: () => api<void>(`/api/rirs/${rir!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted RIR ${rir!.name}`)
      qc.invalidateQueries({ queryKey: ["rirs"] })
      qc.invalidateQueries({ queryKey: ["rirs-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!rir} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete RIR {rir?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `This RIR is referenced by ${rir?.aggregate_count} aggregate${rir?.aggregate_count === 1 ? "" : "s"}. Reassign or delete them first — the API will protect them anyway.`
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
