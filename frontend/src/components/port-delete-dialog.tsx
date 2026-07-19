import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type FrontPort, type RearPort } from "@/lib/api"
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

type Kind = "rear" | "front"

export interface PortDeleteDialogProps {
  kind: Kind
  port: RearPort | FrontPort | null
  deviceId: string
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function PortDeleteDialog({
  kind,
  port,
  deviceId,
  onOpenChange,
  onDeleted,
}: PortDeleteDialogProps) {
  const qc = useQueryClient()
  const endpoint = kind === "rear" ? "rear-ports" : "front-ports"
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/${endpoint}/${port!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${port!.name}`)
      qc.invalidateQueries({ queryKey: [`device-${kind}-ports`, deviceId] })
      // Deleting a rear port cascades its front ports; refresh both lists.
      qc.invalidateQueries({ queryKey: ["device-front-ports", deviceId] })
      qc.invalidateQueries({ queryKey: ["rear-ports-picker", deviceId] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const cabled = !!port?.cable
  const frontCount =
    kind === "rear" ? ((port as RearPort | null)?.front_port_count ?? 0) : 0

  let warning = "This action can't be undone."
  if (cabled) warning = "The cable attached to this port will also be removed."
  else if (frontCount > 0)
    warning = `${frontCount} front port${frontCount === 1 ? "" : "s"} mapped to this rear port will also be removed.`

  return (
    <AlertDialog open={!!port} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {port?.name}?</AlertDialogTitle>
          <AlertDialogDescription>{warning}</AlertDialogDescription>
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
