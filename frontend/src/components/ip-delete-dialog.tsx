import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type IPAddress } from "@/lib/api"
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

export interface IpDeleteDialogProps {
  ip: IPAddress | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function IpDeleteDialog({
  ip,
  onOpenChange,
  onDeleted,
}: IpDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => api<void>(`/api/ips/${ip!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${ip!.ip_address}`)
      qc.invalidateQueries({ queryKey: ["prefix-ips"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!ip} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {ip?.ip_address}?</AlertDialogTitle>
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
