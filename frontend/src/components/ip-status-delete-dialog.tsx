import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Status } from "@/lib/api"
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

export interface IpStatusDeleteDialogProps {
  status: Status | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function IpStatusDeleteDialog({
  status,
  onOpenChange,
  onDeleted,
}: IpStatusDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/statuses/${status!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${status!.name}`)
      qc.invalidateQueries({ queryKey: ["statuses"] })
      qc.invalidateQueries({ queryKey: ["statuses-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const usage = status?.usage_count ?? 0
  return (
    <AlertDialog open={!!status} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete status {status?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `${usage} IP${usage === 1 ? "" : "s"} currently use this status — they'll be left without one.`
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
