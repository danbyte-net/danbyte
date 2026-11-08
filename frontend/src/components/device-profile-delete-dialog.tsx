import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceProfile } from "@/lib/api"
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
import { PROFILES_ENDPOINT } from "@/components/device-profile-assign"

/** Delete one device profile. The server refuses (409) while it is assigned
 * or has child profiles; the dialog says so up front. */
export function DeviceProfileDeleteDialog({
  profile: p,
  onOpenChange,
  onDeleted,
}: {
  profile: DeviceProfile | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`${PROFILES_ENDPOINT}${p!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${p!.name}`)
      qc.invalidateQueries({ queryKey: ["device-profiles"] })
      qc.invalidateQueries({ queryKey: ["device-profiles-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const assigned = (p?.assignment_count ?? 0) > 0
  const children = (p?.child_count ?? 0) > 0
  return (
    <AlertDialog open={!!p} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete profile {p?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {assigned
              ? "Unassign it from its objects first."
              : children
                ? "Move or delete its child profiles first."
                : "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || assigned || children}
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
