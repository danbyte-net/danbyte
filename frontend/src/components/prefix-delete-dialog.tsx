import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Prefix } from "@/lib/api"
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

// Single-prefix delete confirm — used by the row's "..." menu. Bulk
// delete lives in prefix-bulk-bar.tsx (different shape, different action).

export interface PrefixDeleteDialogProps {
  prefix: Prefix | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function PrefixDeleteDialog({
  prefix,
  onOpenChange,
  onDeleted,
}: PrefixDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/prefixes/${prefix!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${prefix!.cidr}`)
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!prefix} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {prefix?.cidr}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone. Child IPs inside this prefix will be
            re-parented to the next-larger container, if any.
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
