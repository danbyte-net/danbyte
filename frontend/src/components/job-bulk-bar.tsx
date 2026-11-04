import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Ban, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { BatchFailure, batchStoppedToast, runBatches } from "@/lib/bulk-batches"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"

/** Job ids per `/api/jobs/bulk-*` call: `MAX_BULK_JOBS` in jobs/views.py. */
export const JOBS_PER_CALL = 500

interface JobBulkAnswer {
  done: string[]
  skipped: { id: string; reason: string }[]
}

const plural = (n: number) => `${n} job${n === 1 ? "" : "s"}`

/**
 * The Queue tab's selection bar: Requeue (failed jobs go back on their
 * queue) and Cancel (after a confirmation). Each job answers as its own
 * Requeue or Cancel does; the ones that cannot are counted in the toast.
 */
export function JobBulkBar({
  ids,
  onCleared,
}: {
  ids: string[]
  onCleared: () => void
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const run = useMutation({
    mutationFn: async (verb: "requeue" | "cancel") => {
      const answers = await runBatches(ids, JOBS_PER_CALL, (part) =>
        api<JobBulkAnswer>(`/api/jobs/bulk-${verb}/`, {
          method: "POST",
          body: JSON.stringify({ ids: part }),
        })
      )
      return {
        done: answers.reduce((n, a) => n + a.done.length, 0),
        skipped: answers.flatMap((a) => a.skipped),
      }
    },
    onSuccess: ({ done, skipped }, verb) => {
      const did = verb === "requeue" ? "Requeued" : "Cancelled"
      const msg = `${did} ${plural(done)}`
      if (skipped.length)
        toast.warning(msg, {
          description: `${plural(skipped.length)} skipped: ${skipped[0].reason}`,
        })
      else toast.success(msg)
      setConfirming(false)
      onCleared()
    },
    onError: (e) => {
      if (e instanceof BatchFailure) batchStoppedToast("Stopped part-way.", e)
      else apiErrorToast(e)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  })
  const busy = run.isPending ? run.variables : undefined
  if (ids.length === 0) return null
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {ids.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={run.isPending}
            onClick={() => run.mutate("requeue")}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {busy === "requeue" ? "Requeuing…" : "Requeue"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-destructive hover:text-destructive"
            disabled={run.isPending}
            onClick={() => setConfirming(true)}
          >
            <Ban className="mr-1 h-3 w-3" /> Cancel
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            aria-label="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Cancel ${plural(ids.length)}?`}
        description="A queued or running job stops and its record is removed."
        confirmLabel="Cancel jobs"
        pendingLabel="Cancelling…"
        pending={busy === "cancel"}
        onConfirm={() => run.mutate("cancel")}
      />
    </>
  )
}
