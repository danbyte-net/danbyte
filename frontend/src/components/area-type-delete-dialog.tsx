import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type AreaType } from "@/lib/api"
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

export function AreaTypeDeleteDialog({
  areaType,
  onOpenChange,
  onDeleted,
}: {
  areaType: AreaType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/area-types/${areaType!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${areaType!.name}`)
      qc.invalidateQueries({ queryKey: ["area-types"] })
      qc.invalidateQueries({ queryKey: ["area-types-picker"] })
      qc.invalidateQueries({ queryKey: ["floor-plan-contents"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const usage = areaType?.area_count ?? 0
  return (
    <AlertDialog open={!!areaType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {areaType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `${usage} area${usage === 1 ? "" : "s"} use this type - they'll be left without one.`
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
