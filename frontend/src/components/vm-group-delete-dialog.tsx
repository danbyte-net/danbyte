import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { VirtualMachineGroup } from "@/lib/api"
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

export interface VmGroupDeleteDialogProps {
  group: VirtualMachineGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

/** Deleting a group never deletes its VMs - they just lose the grouping. */
export function VmGroupDeleteDialog({
  group,
  onOpenChange,
  onDeleted,
}: VmGroupDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/vm-groups/${group!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${group!.name}`)
      qc.invalidateQueries({ queryKey: ["vm-groups"] })
      qc.invalidateQueries({ queryKey: ["vm-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["embedded-vm-groups"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const n = group?.vm_count ?? 0
  return (
    <AlertDialog open={!!group} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete VM group {group?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {n > 0
              ? `Its ${n} virtual machine${n === 1 ? "" : "s"} stay, without a group.`
              : "This action can't be undone."}
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
