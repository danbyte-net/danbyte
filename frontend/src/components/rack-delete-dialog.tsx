import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Rack } from "@/lib/api"
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

export interface RackDeleteDialogProps {
  rack: Rack | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function RackDeleteDialog({
  rack,
  onOpenChange,
  onDeleted,
}: RackDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/racks/${rack!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rack!.name}`)
      qc.invalidateQueries({ queryKey: ["racks"] })
      qc.invalidateQueries({ queryKey: ["racks-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const inUse = (rack?.device_count ?? 0) > 0
  return (
    <AlertDialog open={!!rack} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete rack {rack?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `Still holds ${rack?.device_count} device${rack?.device_count === 1 ? "" : "s"}. Move or delete them first.`
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
