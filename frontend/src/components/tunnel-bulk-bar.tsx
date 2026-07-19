import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api, type Tunnel } from "@/lib/api"
import { Button } from "@/components/ui/button"
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

export interface TunnelBulkBarProps {
  selected: Tunnel[]
  onCleared: () => void
}

export function TunnelBulkBar({ selected, onCleared }: TunnelBulkBarProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (selected.length === 0) return null
  const ids = selected.map((t) => t.id)

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-1 h-3 w-3" /> Delete selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            title="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <BulkDeleteConfirm
        ids={ids}
        sample={selected.slice(0, 5).map((t) => t.name)}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDone={onCleared}
      />
    </>
  )
}

function BulkDeleteConfirm({
  ids,
  sample,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[]
  sample: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: async () => {
      // Tunnels have no bulk-delete endpoint — delete each row in turn.
      await Promise.all(
        ids.map((id) => api<void>(`/api/tunnels/${id}/`, { method: "DELETE" }))
      )
    },
    onSuccess: () => {
      toast.success(
        `Deleted ${ids.length} tunnel${ids.length === 1 ? "" : "s"}.`
      )
      qc.invalidateQueries({ queryKey: ["tunnels"] })
      onOpenChange(false)
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  const extra = Math.max(0, ids.length - sample.length)
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {ids.length} tunnel{ids.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone. The following will be removed:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
          {sample.map((s) => (
            <li key={s}>{s}</li>
          ))}
          {extra > 0 && (
            <li className="text-muted-foreground">…and {extra} more</li>
          )}
        </ul>
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
            {m.isPending ? "Deleting…" : `Delete ${ids.length}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
