import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type ClusterGroup } from "@/lib/api"
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

export interface ClusterGroupDeleteDialogProps {
  clusterGroup: ClusterGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ClusterGroupDeleteDialog({
  clusterGroup,
  onOpenChange,
  onDeleted,
}: ClusterGroupDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/cluster-groups/${clusterGroup!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${clusterGroup!.name}`)
      qc.invalidateQueries({ queryKey: ["cluster-groups"] })
      qc.invalidateQueries({ queryKey: ["cluster-groups-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const inUse = (clusterGroup?.cluster_count ?? 0) > 0
  return (
    <AlertDialog open={!!clusterGroup} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {clusterGroup?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `${clusterGroup?.cluster_count} cluster(s) reference this group — reassign or delete them first.`
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
