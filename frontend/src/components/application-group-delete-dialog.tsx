import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ApplicationGroup } from "@/lib/api"
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

/** Delete one application group. The server refuses (409) while it is
 * assigned to a device or VM; the dialog says so up front. */
export function ApplicationGroupDeleteDialog({
  group: g,
  onOpenChange,
  onDeleted,
}: {
  group: ApplicationGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/application-groups/${g!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${g!.name}`)
      qc.invalidateQueries({ queryKey: ["application-groups"] })
      qc.invalidateQueries({ queryKey: ["application-groups-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const held = (g?.host_count ?? 0) > 0
  return (
    <AlertDialog open={!!g} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete group {g?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {held
              ? "Unassign it from its hosts first."
              : "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || held}
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
