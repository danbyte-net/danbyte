import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CableMini } from "@/lib/api"
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

/** The bits every cable-bearing device component shares. */
interface DeletableComponent {
  id: string
  name: string
  cable: CableMini | null
}

export interface ComponentDeleteDialogProps {
  /** API resource, e.g. "console-ports" → DELETE /api/console-ports/<id>/. */
  endpoint: string
  /** Query keys to invalidate after a delete (the pane's list queries). */
  queryKeys: unknown[][]
  item: DeletableComponent | null
  /** Extra warning line shown instead of the generic one (cable wins). */
  warning?: string
  onOpenChange: (open: boolean) => void
}

// Delete confirm shared by the console/power component tables — same pattern
// as PortDeleteDialog, parameterised over the endpoint.
export function ComponentDeleteDialog({
  endpoint,
  queryKeys,
  item,
  warning,
  onOpenChange,
}: ComponentDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/${endpoint}/${item!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${item!.name}`)
      for (const key of queryKeys) qc.invalidateQueries({ queryKey: key })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  let line = warning ?? "This action can't be undone."
  if (item?.cable)
    line = "The cable attached to this port will also be removed."

  return (
    <AlertDialog open={!!item} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {item?.name}?</AlertDialogTitle>
          <AlertDialogDescription>{line}</AlertDialogDescription>
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
