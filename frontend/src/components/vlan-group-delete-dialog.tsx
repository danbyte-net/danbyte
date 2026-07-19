import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type VLANGroup } from "@/lib/api"
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

export interface VlanGroupDeleteDialogProps {
  group: VLANGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function VlanGroupDeleteDialog({
  group,
  onOpenChange,
  onDeleted,
}: VlanGroupDeleteDialogProps) {
  const qc = useQueryClient()
  const blocked = !!group && group.vlan_count > 0
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/vlan-groups/${group!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted group ${group!.name}`)
      qc.invalidateQueries({ queryKey: ["vlan-groups"] })
      qc.invalidateQueries({ queryKey: ["vlan-groups-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!group} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete group {group?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `This group still has ${group?.vlan_count} VLAN${group?.vlan_count === 1 ? "" : "s"}. Reassign or delete them first — the API will protect them anyway.`
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
