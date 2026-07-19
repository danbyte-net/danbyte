import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type ClusterType } from "@/lib/api"
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

export interface ClusterTypeDeleteDialogProps {
  clusterType: ClusterType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ClusterTypeDeleteDialog({
  clusterType,
  onOpenChange,
  onDeleted,
}: ClusterTypeDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/cluster-types/${clusterType!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${clusterType!.name}`)
      qc.invalidateQueries({ queryKey: ["cluster-types"] })
      qc.invalidateQueries({ queryKey: ["cluster-types-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const inUse = (clusterType?.cluster_count ?? 0) > 0
  return (
    <AlertDialog open={!!clusterType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {clusterType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `${clusterType?.cluster_count} cluster(s) reference this type — reassign or delete them first.`
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
