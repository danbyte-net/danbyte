import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type MacObject } from "@/lib/api"
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

export interface MacObjectDeleteDialogProps {
  object: MacObject | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function MacObjectDeleteDialog({
  object,
  onOpenChange,
  onDeleted,
}: MacObjectDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/mac-addresses/${object!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${object!.description || "MAC object"}`)
      qc.invalidateQueries({ queryKey: ["macs"] })
      qc.invalidateQueries({ queryKey: ["mac"] })
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      qc.invalidateQueries({ queryKey: ["interface"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!object} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this MAC object?</AlertDialogTitle>
          <AlertDialogDescription>
            The MAC object
            {object?.assigned_interface
              ? " and its interface assignment"
              : ""}{" "}
            will be removed. This doesn't clear the hardware address on the
            interface or IP — those keep their recorded value. This action can't
            be undone.
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
