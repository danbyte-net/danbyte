import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Cluster } from "@/lib/api"
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

export interface ClusterDeleteDialogProps {
  cluster: Cluster | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ClusterDeleteDialog({
  cluster,
  onOpenChange,
  onDeleted,
}: ClusterDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/clusters/${cluster!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${cluster!.name}`)
      qc.invalidateQueries({ queryKey: ["clusters"] })
      qc.invalidateQueries({ queryKey: ["clusters-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const inUse = (cluster?.vm_count ?? 0) > 0
  return (
    <AlertDialog open={!!cluster} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete cluster {cluster?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `Still referenced by ${cluster?.vm_count} virtual machine${cluster?.vm_count === 1 ? "" : "s"}. Reassign or delete them first.`
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
