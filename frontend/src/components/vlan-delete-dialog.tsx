import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type VLAN } from "@/lib/api"
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

export interface VlanDeleteDialogProps {
  vlan: VLAN | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function VlanDeleteDialog({
  vlan,
  onOpenChange,
  onDeleted,
}: VlanDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/vlans/${vlan!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted VLAN ${vlan!.vlan_id}`)
      qc.invalidateQueries({ queryKey: ["vlans"] })
      qc.invalidateQueries({ queryKey: ["vlans-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!vlan} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete VLAN {vlan?.vlan_id} ({vlan?.name})?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {vlan && vlan.prefix_count > 0
              ? `This VLAN is referenced by ${vlan.prefix_count} prefix${vlan.prefix_count === 1 ? "" : "es"}. They'll be detached but not deleted.`
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
