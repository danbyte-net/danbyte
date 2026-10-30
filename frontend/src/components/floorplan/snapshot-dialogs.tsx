import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanArea,
  FloorPlanCrop,
  FloorPlanSnapshotPayload,
  FloorPlanSnapshotResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Field } from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { scopeName } from "@/lib/floor-plan-scope"

import { areaColor, areaName, shapeBounds } from "./shapes"
import { MAX_MARGIN, areaCrop } from "./snapshot"

// The Snapshot dialog - after a rectangle is dragged on the plan, or for a
// room, location or area (its menu, its toolbar, a room's page) - and
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

/** An area as the dialog's picker offers it: its colour badge, under Rooms,
 * Locations or Areas. */
export function areaOption(a: FloorPlanArea): ComboboxOption {
  return {
    value: a.id,
    label: areaName(a) || "Area",
    color: areaColor(a),
    badge: true,
    group: a.room ? "Rooms" : a.location ? "Locations" : "Areas",
  }
}

/** Name, what the snapshot takes - the dragged rectangle, or a room,
 * location or area of `areas` with a margin - where it goes, and whether
 * it is a copy or a live view. Open while `crop` or `areaId` is set. */
export function SnapshotDialog({
  plan,
  crop = null,
  areaId = null,
  areas = [],
  onOpenChange,
  onCreated,
}: {
  plan: FloorPlan
  /** The dragged rectangle (in `plan`'s cells). */
  crop?: FloorPlanCrop | null
  /** Start from this area. */
  areaId?: string | null
  /** The plan's saved areas (in `plan`'s cells), to pick from. */
  areas?: FloorPlanArea[]
  onOpenChange: (open: boolean) => void
  onCreated: (plan: FloorPlanSnapshotResult) => void
}) {
  const open = crop !== null || areaId !== null
  const [of, setOf] = useState<"rect" | "area">("rect")
  const [picked, setPicked] = useState<string | null>(null)
  const [margin, setMargin] = useState("0")
  const [name, setName] = useState("")
  const [named, setNamed] = useState(false)
  const [target, setTarget] =
    useState<FloorPlanSnapshotPayload["target"]>("plan")
  const [mode, setMode] = useState<FloorPlanSnapshotPayload["mode"]>("copy")
  const byId = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas])
  useEffect(() => {
    if (!open) return
    const start = areaId ?? (crop ? null : (areas[0]?.id ?? null))
    const a = start ? byId.get(start) : undefined
    setOf(crop && !areaId ? "rect" : "area")
    setPicked(start)
    setMargin("0")
    setName(a ? areaName(a) : "")
    setNamed(false)
    setTarget("plan")
    setMode("copy")
    // Only on opening: the areas refetch under an open dialog.
  }, [open, areaId, crop])
  const options = useMemo(() => areas.map(areaOption), [areas])
  const area = picked ? byId.get(picked) : undefined
  const m = Number(margin)
  const marginOk =
    margin.trim() !== "" && Number.isInteger(m) && m >= 0 && m <= MAX_MARGIN
  const size =
    of === "rect"
      ? crop
      : area && marginOk
        ? areaCrop(
            shapeBounds({ ...area, kind: "area" }, plan.cell_mm),
            m,
            plan.grid_width,
            plan.grid_height
          )
        : null
  const ready = !!name.trim() && (of === "rect" ? !!crop : !!picked && marginOk)
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
  const pick = (id: string | null) => {
    setPicked(id)
    const a = id ? byId.get(id) : undefined
    if (!named) setName(a ? areaName(a) : "")
  }
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
            if (!ready) return
            const base = { name: name.trim(), mode, target }
            if (of === "rect" && crop) make.mutate({ ...base, crop })
            else if (picked)
              make.mutate({ ...base, area_id: picked, margin: m })
          }}
        >
          {size && (
            <p className="num text-xs text-muted-foreground">
              {size.w}×{size.h} cells
            </p>
          )}
          {crop && areas.length > 0 && (
            <Field label="Of">
              <RadioGroup
                value={of}
                onValueChange={(v) => {
                  setOf(v as typeof of)
                  if (v === "area" && !picked) pick(areas[0]?.id ?? null)
                }}
              >
                <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                  <RadioGroupItem value="rect" />
                  The drawn rectangle
                </Label>
                <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                  <RadioGroupItem value="area" />A room, location or area
                </Label>
              </RadioGroup>
            </Field>
          )}
          {of === "area" && (
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label="Room or area">
                <Combobox
                  value={picked}
                  onChange={pick}
                  options={options}
                  placeholder="Pick an area…"
                  emptyText="No areas on this floor."
                />
              </Field>
              <Field label="Margin">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_MARGIN}
                  step={1}
                  value={margin}
                  onChange={(e) => setMargin(e.target.value)}
                  className="num h-9"
                  aria-invalid={!marginOk}
                />
              </Field>
            </div>
          )}
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNamed(true)
              }}
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
                New floor plan at {scopeName(plan)}
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
            <Button type="submit" disabled={!ready || make.isPending}>
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
