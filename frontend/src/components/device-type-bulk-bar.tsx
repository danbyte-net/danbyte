import { useState } from "react"
import { BulkExport } from "@/components/bulk-export"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceType } from "@/lib/api"
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
import { PendingLabel } from "@/components/pending-label"
import { apiErrorToast } from "@/lib/api-toast"
import {
  BatchFailure,
  batchCount,
  batchStoppedToast,
  runBatches,
  sumOf,
} from "@/lib/bulk-batches"
import type { BatchProgress } from "@/lib/bulk-batches"

// Types per call. The server takes 1000, but a library import is easily 800
// types with dozens of port templates each, and one request for all of them
// outran the backend's request timeout (#178).
const TYPES_PER_CALL = 100

// Floating action bar for /device-types - appears when rows are ticked. No
// Edit link: there is no /device-types/bulk-edit route (unlike sites, IPs,
// prefixes and VLANs), and a bar that links to a 404 is worse than one that
// doesn't offer the action.
export interface DeviceTypeBulkBarProps {
  selected: DeviceType[]
  onCleared: () => void
}

export function DeviceTypeBulkBar({
  selected,
  onCleared,
}: DeviceTypeBulkBarProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (selected.length === 0) return null
  const ids = selected.map((d) => d.id)
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <BulkExport ioType="devicetype" ids={ids} />
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
        sample={selected.slice(0, 5).map((d) => d.name)}
        deviceCount={selected.reduce((n, d) => n + d.device_count, 0)}
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
  deviceCount,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[]
  sample: string[]
  /** Devices across the whole selection - see the warning copy below. */
  deviceCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const m = useMutation({
    mutationFn: async () =>
      sumOf(
        await runBatches(
          ids,
          TYPES_PER_CALL,
          (part) =>
            api<{ deleted: number }>("/api/device-types/bulk-delete/", {
              method: "POST",
              body: JSON.stringify({ ids: part }),
            }),
          setProgress
        ),
        (r) => r.deleted
      ),
    onSuccess: (deleted) => {
      toast.success(
        `Deleted ${deleted} device type${deleted === 1 ? "" : "s"}.`
      )
      onOpenChange(false)
      onDone()
    },
    onError: (err) => {
      if (!(err instanceof BatchFailure)) {
        apiErrorToast(err)
        return
      }
      // Some batches went through: say how many, and close. The rest stay
      // selected for another go.
      const went: { deleted: number }[] = err.results
      batchStoppedToast(
        `Deleted ${sumOf(went, (r) => r.deleted)} of ${ids.length} device types.`,
        err
      )
      onOpenChange(false)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["device-types"] })
      qc.invalidateQueries({ queryKey: ["device-types-picker"] })
    },
  })

  const extra = Math.max(0, ids.length - sample.length)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (o || !m.isPending) onOpenChange(o)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {ids.length} device type{ids.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          {/* Same warning the single-row dialog gives, summed over the
              selection: Device.device_type is SET_NULL, so the devices keep
              running - they just stop knowing what they are. Detyping 40 live
              devices must never be a surprise. */}
          <AlertDialogDescription>
            {deviceCount > 0
              ? `${deviceCount} device${deviceCount === 1 ? "" : "s"} use these types - they'll keep working but lose their type reference.`
              : "This action can't be undone."}{" "}
            The following will be removed:
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
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            <PendingLabel
              label={`Delete ${ids.length}`}
              verb="Deleting…"
              pending={m.isPending}
              progress={progress}
              batches={batchCount(ids.length, TYPES_PER_CALL)}
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
