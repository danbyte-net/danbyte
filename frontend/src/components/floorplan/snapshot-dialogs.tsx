import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanCrop,
  FloorPlanSnapshotPayload,
  FloorPlanSnapshotResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Field } from "@/components/forms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

// The Snapshot tool's dialog (after a rectangle is dragged on the plan) and
// Unlink, which turns a live view into an independent copy.

/** "N objects cross the edge…" - copied whole, not clipped. */
function crossingNote(r: FloorPlanSnapshotResult): string | undefined {
  const n = r.crossing.length
  if (!n) return undefined
  return `${n} object${n === 1 ? "" : "s"} crossed the edge and ${n === 1 ? "was" : "were"} copied whole.`
}

function useInvalidatePlans() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ["floor-plan-stack"] })
    void qc.invalidateQueries({ queryKey: ["floor-plan-stacks"] })
    void qc.invalidateQueries({ queryKey: ["floor-plan"] })
    void qc.invalidateQueries({ queryKey: ["floor-plans"] })
  }
}

/** Name, where the snapshot goes, and whether it is a copy or a live view
 * of `crop` (in `plan`'s cells). */
export function SnapshotDialog({
  plan,
  crop,
  onOpenChange,
  onCreated,
}: {
  plan: FloorPlan
  /** The dragged rectangle; null closes the dialog. */
  crop: FloorPlanCrop | null
  onOpenChange: (open: boolean) => void
  onCreated: (plan: FloorPlanSnapshotResult) => void
}) {
  const open = crop !== null
  const [name, setName] = useState("")
  const [target, setTarget] =
    useState<FloorPlanSnapshotPayload["target"]>("plan")
  const [mode, setMode] = useState<FloorPlanSnapshotPayload["mode"]>("copy")
  useEffect(() => {
    if (open) {
      setName("")
      setTarget("plan")
      setMode("copy")
    }
  }, [open])
  const invalidate = useInvalidatePlans()
  const make = useMutation({
    mutationFn: (body: FloorPlanSnapshotPayload) =>
      api<FloorPlanSnapshotResult>(`/api/floor-plans/${plan.id}/snapshot/`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (made) => {
      invalidate()
      toast.success(`Snapshot ${made.name} made`, {
        description: crossingNote(made),
      })
      onOpenChange(false)
      onCreated(made)
    },
    onError: (e) => apiErrorToast(e),
  })
  const source = plan.stack ? `${plan.stack.name} · ${plan.name}` : plan.name
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Snapshot of {source}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (crop && name.trim())
              make.mutate({ name: name.trim(), crop, mode, target })
          }}
        >
          <p className="num text-xs text-muted-foreground">
            {crop?.w}×{crop?.h} cells
          </p>
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Room 210"
              className="h-9"
              maxLength={128}
            />
          </Field>
          <Field label="Goes to">
            <RadioGroup
              value={target}
              onValueChange={(v) => setTarget(v as typeof target)}
            >
              <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                <RadioGroupItem value="plan" />
                New floor plan at {plan.location.name}
              </Label>
              {plan.stack && (
                <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                  <RadioGroupItem value="floor" />
                  New floor of {plan.stack.name}
                </Label>
              )}
            </RadioGroup>
          </Field>
          <Field label="Kind">
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as typeof mode)}
            >
              <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                <RadioGroupItem value="copy" />
                Independent copy
              </Label>
              <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                <RadioGroupItem value="view" />
                Keep in sync (live view)
              </Label>
            </RadioGroup>
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || make.isPending}>
              {make.isPending ? "Creating…" : "Create snapshot"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Unlink a live view: it becomes an independent copy of what it shows
 * now. Cannot be undone. */
export function UnlinkViewDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: FloorPlan
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const invalidate = useInvalidatePlans()
  const qc = useQueryClient()
  const unlink = useMutation({
    mutationFn: () =>
      api<FloorPlanSnapshotResult>(`/api/floor-plans/${plan.id}/unlink/`, {
        method: "POST",
      }),
    onSuccess: (made) => {
      invalidate()
      void qc.invalidateQueries({ queryKey: ["floor-plan-contents", plan.id] })
      void qc.invalidateQueries({ queryKey: ["floor-plan-drawing", plan.id] })
      toast.success(`${plan.name} unlinked`, {
        description: crossingNote(made),
      })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  const source = plan.snapshot?.source?.name ?? "its source"
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Unlink ${plan.name}?`}
      description={`It becomes an independent copy of what it shows of ${source} now. This cannot be undone.`}
      confirmLabel="Unlink"
      pendingLabel="Unlinking…"
      pending={unlink.isPending}
      onConfirm={() => unlink.mutate()}
    />
  )
}
