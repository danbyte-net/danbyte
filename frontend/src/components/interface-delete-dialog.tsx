import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Interface } from "@/lib/api"
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

export interface InterfaceDeleteDialogProps {
  iface: Interface | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function InterfaceDeleteDialog({
  iface,
  onOpenChange,
  onDeleted,
}: InterfaceDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/interfaces/${iface!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${iface!.name}`)
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const cables = iface?.cable_count ?? 0
  return (
    <AlertDialog open={!!iface} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {iface?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {cables > 0
              ? `${cables} cable${cables === 1 ? "" : "s"} attached to this interface will also be removed.`
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
