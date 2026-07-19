import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type ContactGroup } from "@/lib/api"
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

export interface ContactGroupDeleteDialogProps {
  item: ContactGroup | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function ContactGroupDeleteDialog({
  item,
  onOpenChange,
  onDeleted,
}: ContactGroupDeleteDialogProps) {
  const qc = useQueryClient()
  const blocked = !!item && item.contact_count > 0
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/contact-groups/${item!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${item!.name}`)
      qc.invalidateQueries({ queryKey: ["contact-groups"] })
      qc.invalidateQueries({ queryKey: ["contact-groups-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!item} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {item?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `This is referenced by ${item?.contact_count} object${item?.contact_count === 1 ? "" : "s"} — reassign them first; the API will protect them anyway.`
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
