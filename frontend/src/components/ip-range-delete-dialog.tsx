import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type IPRange } from "@/lib/api"
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

export interface IpRangeDeleteDialogProps {
  range: IPRange | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function IpRangeDeleteDialog({
  range,
  onOpenChange,
  onDeleted,
}: IpRangeDeleteDialogProps) {
  const qc = useQueryClient()
  const label = range ? `${range.start_address}–${range.end_address}` : ""
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/ip-ranges/${range!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted range ${label}`)
      qc.invalidateQueries({ queryKey: ["ip-ranges"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!range} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete IP range {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the range record only — individual IP addresses inside
            it are not touched. This action can't be undone.
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
