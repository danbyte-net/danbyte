import { useEffect } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorPlanSnapAllResult } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Loading } from "@/components/loading"

import { floorPlanContentsKey } from "./use-floor-plan-data"

/**
 * Back to the grid: a free plan's tiles move onto whole cells and quarter
 * turns. Opening it asks the server what would move (a dry run) and which
 * tiles would then stand on each other; nothing moves until confirmed.
 * Unsaved edits must be saved first - the snap works on the saved plan.
 */
export function SnapAllDialog({
  planId,
  open,
  onOpenChange,
  isDirty,
  onMoved,
}: {
  planId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  isDirty: boolean
  /** Tiles moved: the routes on them may be out of date now. */
  onMoved?: () => void
}) {
  const qc = useQueryClient()
  const url = `/api/floor-plans/${planId}/snap-all/`
  const preview = useMutation({
    mutationFn: () =>
      api<FloorPlanSnapAllResult>(url, {
        method: "POST",
        body: JSON.stringify({ dry_run: true }),
      }),
    onError: (err) => apiErrorToast(err),
  })
  const apply = useMutation({
    mutationFn: () =>
      api<FloorPlanSnapAllResult>(url, {
        method: "POST",
        body: JSON.stringify({ dry_run: false }),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["floor-plan", planId] })
      qc.invalidateQueries({ queryKey: floorPlanContentsKey(planId) })
      // Moved tiles leave the routes on them out of date.
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", planId] })
      if (res.moved) onMoved?.()
      toast.success(
        res.moved
          ? `Back on the grid - ${res.moved} tile${res.moved === 1 ? "" : "s"} moved`
          : "Back on the grid"
      )
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  useEffect(() => {
    if (open && !isDirty) preview.mutate()
    if (!open) preview.reset()
  }, [open, isDirty])

  const res = preview.data
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Snap all to the grid?"
      description={
        isDirty
          ? "Save the plan first."
          : "Tiles move onto whole cells and quarter turns."
      }
      confirmLabel="Snap all"
      pendingLabel="Snapping…"
      pending={apply.isPending}
      confirmDisabled={isDirty || !res}
      onConfirm={() => apply.mutate()}
    >
      {!isDirty && preview.isPending && <Loading />}
      {res && (
        <div className="grid gap-2 text-sm">
          <p>
            <span className="num">{res.moved}</span> tile
            {res.moved === 1 ? "" : "s"} move.
          </p>
          {res.collisions.length > 0 && (
            <div>
              <p className="text-muted-foreground">
                These would stand on another tile:
              </p>
              <ul className="mt-1 max-h-40 list-disc overflow-auto pl-5">
                {res.collisions.map((c) => (
                  <li key={c.id}>{c.name || "Unnamed tile"}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ConfirmDialog>
  )
}
