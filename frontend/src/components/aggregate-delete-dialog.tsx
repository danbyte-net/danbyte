import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Aggregate } from "@/lib/api"
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

export interface AggregateDeleteDialogProps {
  aggregate: Aggregate | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function AggregateDeleteDialog({
  aggregate,
  onOpenChange,
  onDeleted,
}: AggregateDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/aggregates/${aggregate!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted aggregate ${aggregate!.prefix}`)
      qc.invalidateQueries({ queryKey: ["aggregates"] })
      qc.invalidateQueries({ queryKey: ["rir-aggregates"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!aggregate} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete aggregate {aggregate?.prefix}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This removes the aggregate record only — prefixes inside it are not
            touched. This action can't be undone.
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
