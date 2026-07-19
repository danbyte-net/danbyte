import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type RouteTarget } from "@/lib/api"
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

export interface RtDeleteDialogProps {
  rt: RouteTarget | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function RtDeleteDialog({
  rt,
  onOpenChange,
  onDeleted,
}: RtDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/route-targets/${rt!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rt!.name}`)
      qc.invalidateQueries({ queryKey: ["rts"] })
      qc.invalidateQueries({ queryKey: ["rts-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const inUse = !!rt && rt.import_vrf_count + rt.export_vrf_count > 0

  return (
    <AlertDialog open={!!rt} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete RT {rt?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `Still used by ${rt?.import_vrf_count} importer${rt?.import_vrf_count === 1 ? "" : "s"} and ${rt?.export_vrf_count} exporter${rt?.export_vrf_count === 1 ? "" : "s"}. Those references will be detached on delete.`
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
