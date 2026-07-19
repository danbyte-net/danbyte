import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type RackRole } from "@/lib/api"
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

export interface RackRoleDeleteDialogProps {
  role: RackRole | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function RackRoleDeleteDialog({
  role,
  onOpenChange,
  onDeleted,
}: RackRoleDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/rack-roles/${role!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${role!.name}`)
      qc.invalidateQueries({ queryKey: ["rack-roles"] })
      qc.invalidateQueries({ queryKey: ["rack-roles-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const usage = role?.rack_count ?? 0
  return (
    <AlertDialog open={!!role} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete role {role?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `${usage} rack${usage === 1 ? "" : "s"} currently use this role — they'll be left without one.`
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
