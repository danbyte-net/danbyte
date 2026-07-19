import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type VRF } from "@/lib/api"
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

export interface VrfDeleteDialogProps {
  vrf: VRF | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function VrfDeleteDialog({
  vrf,
  onOpenChange,
  onDeleted,
}: VrfDeleteDialogProps) {
  const qc = useQueryClient()
  const blocked = !!vrf && vrf.prefix_count > 0
  const m = useMutation({
    mutationFn: () => api<void>(`/api/vrfs/${vrf!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted VRF ${vrf!.name}`)
      qc.invalidateQueries({ queryKey: ["vrfs"] })
      qc.invalidateQueries({ queryKey: ["vrfs-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!vrf} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete VRF {vrf?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `This VRF still owns ${vrf?.prefix_count} prefix${vrf?.prefix_count === 1 ? "" : "es"}. Move or delete them first — the API will protect them anyway.`
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
