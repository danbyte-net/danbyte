import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type PlatformGroup } from "@/lib/api"
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

export interface PlatformGroupDeleteDialogProps {
  group: PlatformGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function PlatformGroupDeleteDialog({
  group,
  onOpenChange,
  onDeleted,
}: PlatformGroupDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/platform-groups/${group!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${group!.name}`)
      qc.invalidateQueries({ queryKey: ["platform-groups"] })
      qc.invalidateQueries({ queryKey: ["platform-groups-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const usage = group?.platform_count ?? 0
  return (
    <AlertDialog open={!!group} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete platform group {group?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `${usage} platform${usage === 1 ? "" : "s"} belong to this group — reassign or delete them first.`
              : "Child groups are kept (they lose their parent). This action can't be undone."}
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
