import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CustomField } from "@/lib/api"
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

export interface CustomFieldDeleteDialogProps {
  field: CustomField | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function CustomFieldDeleteDialog({
  field,
  onOpenChange,
  onDeleted,
}: CustomFieldDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/custom-fields/${field!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${field!.label}`)
      qc.invalidateQueries({ queryKey: ["custom-fields"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!field} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete field {field?.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The definition is removed from forms. Any values already stored
            under <span className="font-mono">{field?.key}</span> on existing
            objects are left in place.
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
