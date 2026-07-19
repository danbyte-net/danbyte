import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Zone } from "@/lib/api"
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

export interface ZoneDeleteDialogProps {
  zone: Zone | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ZoneDeleteDialog({
  zone,
  onOpenChange,
  onDeleted,
}: ZoneDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/zones/${zone!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${zone!.name}`)
      qc.invalidateQueries({ queryKey: ["zones"] })
      qc.invalidateQueries({ queryKey: ["zones-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const usage = zone?.usage_count ?? 0
  return (
    <AlertDialog open={!!zone} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete zone {zone?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `${usage} VLAN${usage === 1 ? "" : "s"} currently use this zone — they'll be left without one.`
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
