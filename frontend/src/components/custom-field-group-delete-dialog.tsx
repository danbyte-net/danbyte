import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CustomFieldGroup } from "@/lib/api"
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

export interface CustomFieldGroupDeleteDialogProps {
  group: CustomFieldGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function CustomFieldGroupDeleteDialog({
  group,
  onOpenChange,
  onDeleted,
}: CustomFieldGroupDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/custom-field-groups/${group!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${group!.name}`)
      qc.invalidateQueries({ queryKey: ["custom-field-groups"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!group} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete group {group?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The section is removed. Any custom fields assigned to{" "}
            <span className="font-mono">{group?.slug}</span> are left ungrouped,
            not deleted.
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
