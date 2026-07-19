import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Tag } from "@/lib/api"
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

export interface TagDeleteDialogProps {
  tag: Tag | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function TagDeleteDialog({
  tag,
  onOpenChange,
  onDeleted,
}: TagDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => api<void>(`/api/tags/${tag!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${tag!.name}`)
      qc.invalidateQueries({ queryKey: ["tags"] })
      qc.invalidateQueries({ queryKey: ["tags-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const usage = tag?.usage_count ?? 0

  return (
    <AlertDialog open={!!tag} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tag {tag?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? `Used by ${usage} object${usage === 1 ? "" : "s"} — the tag will be removed from them.`
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
