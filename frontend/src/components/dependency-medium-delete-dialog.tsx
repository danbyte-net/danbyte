import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DependencyMedium } from "@/lib/api"
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
import { DEPENDENCY_MEDIUM_KEYS } from "@/components/dependency-medium-form"

/** A medium still in use is kept: the server answers 409 with the count. */
export function DependencyMediumDeleteDialog({
  medium,
  onOpenChange,
  onDeleted,
}: {
  medium: DependencyMedium | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/dependency-media/${medium!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${medium!.name}`)
      for (const queryKey of DEPENDENCY_MEDIUM_KEYS)
        qc.invalidateQueries({ queryKey })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const inUse = (medium?.usage_count ?? 0) > 0
  return (
    <AlertDialog open={!!medium} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {medium?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? "Dependencies still use this medium. Give them another one first."
              : "This can't be undone."}
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
