import { useState } from "react"
import { BulkExport } from "@/components/bulk-export"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api, type IPSecProfile } from "@/lib/api"
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

export interface IPSecProfileBulkBarProps {
  selected: IPSecProfile[]
  onCleared: () => void
}

export function IPSecProfileBulkBar({
  selected,
  onCleared,
}: IPSecProfileBulkBarProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (selected.length === 0) return null
  const ids = selected.map((p) => p.id)

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <BulkExport ioType="ipsecprofile" ids={ids} />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-1 h-3 w-3" /> Delete
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
        sample={selected.slice(0, 5).map((p) => p.name)}
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
  // No bulk-delete endpoint for IPSec profiles — DELETE each one. allSettled so
  // a partial failure still reflects the profiles that were actually removed.
  const m = useMutation({
    mutationFn: () =>
      Promise.allSettled(
        ids.map((id) =>
          api<void>(`/api/ipsec-profiles/${id}/`, { method: "DELETE" })
        )
      ),
    onSuccess: (results) => {
      const deleted = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - deleted
      if (deleted > 0) {
        toast.success(`Deleted ${deleted} profile${deleted === 1 ? "" : "s"}.`)
      }
      if (failed > 0) {
        toast.error(
          `Failed to delete ${failed} profile${failed === 1 ? "" : "s"}.`
        )
      }
      qc.invalidateQueries({ queryKey: ["ipsec-profiles"] })
      qc.invalidateQueries({ queryKey: ["ipsec-profiles-picker"] })
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
            Delete {ids.length} profile{ids.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone. The following will be removed:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
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
