import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type LocationType } from "@/lib/api"
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

export function LocationTypeDeleteDialog({
  locationType,
  onOpenChange,
  onDeleted,
}: {
  locationType: LocationType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/location-types/${locationType!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${locationType!.name}`)
      qc.invalidateQueries({ queryKey: ["location-types"] })
      qc.invalidateQueries({ queryKey: ["location-types-picker"] })
      qc.invalidateQueries({ queryKey: ["locations"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const usage = locationType?.location_count ?? 0
  return (
    <AlertDialog open={!!locationType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {locationType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `${usage} location${usage === 1 ? "" : "s"} use this type - they'll be left without one.`
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
