import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Contact } from "@/lib/api"
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

export interface ContactDeleteDialogProps {
  contact: Contact | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ContactDeleteDialog({
  contact,
  onOpenChange,
  onDeleted,
}: ContactDeleteDialogProps) {
  const qc = useQueryClient()
  const n = contact?.assignment_count ?? 0
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/contacts/${contact!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${contact!.name}`)
      qc.invalidateQueries({ queryKey: ["contacts"] })
      qc.invalidateQueries({ queryKey: ["contacts-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!contact} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {contact?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {n > 0
              ? `This contact is attached to ${n} object${n === 1 ? "" : "s"}; those assignments will be removed too. `
              : ""}
            This action can't be undone.
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
