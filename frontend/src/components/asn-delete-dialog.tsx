import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type ASN } from "@/lib/api"
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

export interface AsnDeleteDialogProps {
  asn: ASN | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function AsnDeleteDialog({
  asn,
  onOpenChange,
  onDeleted,
}: AsnDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => api<void>(`/api/asns/${asn!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted AS${asn!.asn}`)
      qc.invalidateQueries({ queryKey: ["asns"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!asn} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete AS{asn?.asn}?</AlertDialogTitle>
          <AlertDialogDescription>
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
