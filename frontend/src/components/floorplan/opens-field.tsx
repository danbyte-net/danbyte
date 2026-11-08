import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ArrowUpRight } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanBackLabelRef,
  FloorPlanOpensRef,
  FloorPlanSnapshotResult,
  FloorPlanStack,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Field } from "@/components/forms"
import { BarIconButton } from "@/components/map-toolbar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { areaName, areaUnder, opensName } from "./shapes"
import type { AreaShape, PlanShape } from "./shapes"
import { floorPlanStackKey } from "./use-floor-plan-data"

// Opens links (docs: floor-plans "Opens links"): the floor plan a click on
// an area or label opens in View - a floor of this plan, a snapshot of it,
// or any other floor plan - and the Back button that keeps a label on the
// target opening this plan back. The Site map's outlines use the picker
// with no plan of their own.

/** The picker's "Make a snapshot of this…" row. */
export const MAKE_SNAPSHOT = "__make_snapshot__"
const HIDDEN = "__hidden__"

/** Groups, in the order the picker lists them. */
export const OPENS_GROUPS = {
  floors: "Floors of this plan",
  snapshots: "Snapshots of this plan",
  others: "Other floor plans",
} as const

type PlanRow = {
  id: string
  name: string
  stack_name: string | null
  kind?: "plan" | "view"
}

type PlanLike = Pick<FloorPlan, "id" | "name" | "stack">

const rowName = (r: PlanRow) =>
  r.stack_name && r.stack_name !== r.name
    ? `${r.stack_name} · ${r.name}`
    : r.name

/** The plans a shape (or outline) may open, grouped: this plan's floors,
 * its snapshots, every other floor plan the reader may view. */
export function useOpensChoices(plan: PlanLike | null, enabled = true) {
  const { canDo } = useMe()
  const canChange = canDo("floorplan", "change")
  const stackId = plan?.stack?.id ?? ""
  const stack = useQuery({
    queryKey: floorPlanStackKey(stackId),
    queryFn: () => api<FloorPlanStack>(`/api/floor-plan-stacks/${stackId}/`),
    enabled: enabled && !!stackId,
    staleTime: 60_000,
  })
  const snaps = useQuery({
    queryKey: ["floor-plans-picker", "source", plan?.id ?? ""],
    queryFn: () =>
      apiAll<PlanRow>(`/api/floor-plans/?picker=1&source=${plan!.id}`),
    enabled: enabled && !!plan,
    staleTime: 60_000,
  })
  const all = useQuery({
    queryKey: ["floor-plans-picker"],
    queryFn: () => apiAll<PlanRow>("/api/floor-plans/?picker=1"),
    enabled,
    staleTime: 60_000,
  })
  return useMemo(() => {
    const refs = new Map<string, FloorPlanOpensRef>()
    const options: ComboboxOption[] = []
    const seen = new Set(plan ? [plan.id] : [])
    const add = (r: PlanRow, group: string, label: string, chip?: string) => {
      if (seen.has(r.id)) return
      seen.add(r.id)
      refs.set(r.id, {
        id: r.id,
        name: r.name,
        stack_name: r.stack_name,
        kind: r.kind ?? "plan",
        can_change: canChange,
      })
      options.push({
        value: r.id,
        label,
        group: plan ? group : undefined,
        chip,
      })
    }
    const stackName = stack.data?.name ?? plan?.stack?.name ?? null
    for (const f of stack.data?.floors ?? [])
      add(
        { id: f.id, name: f.name, stack_name: stackName, kind: f.kind },
        OPENS_GROUPS.floors,
        f.name,
        f.kind === "view" ? "View" : undefined
      )
    for (const r of snaps.data?.results ?? [])
      add(
        r,
        OPENS_GROUPS.snapshots,
        rowName(r),
        r.kind === "view" ? "View" : "Copy"
      )
    for (const r of all.data?.results ?? [])
      add(
        r,
        OPENS_GROUPS.others,
        rowName(r),
        r.kind === "view" ? "View" : undefined
      )
    return { options, refs }
  }, [plan, stack.data, snaps.data, all.data, canChange])
}

/** The Opens picker: a searchable list in the three groups, a row to clear
 * it, and - when `onMakeSnapshot` is given - "Make a snapshot of this…",
 * which makes the snapshot and links to it in one step. */
export function OpensPicker({
  plan,
  value,
  hidden = false,
  onChange,
  onMakeSnapshot,
  "aria-label": ariaLabel,
}: {
  plan: PlanLike | null
  value: FloorPlanOpensRef | null | undefined
  /** It opens a plan the reader may not view. */
  hidden?: boolean
  onChange: (ref: FloorPlanOpensRef | null) => void
  onMakeSnapshot?: () => void
  "aria-label"?: string
}) {
  const { options, refs } = useOpensChoices(plan)
  const all = useMemo(() => {
    const out = [...options]
    if (onMakeSnapshot)
      out.push({
        value: MAKE_SNAPSHOT,
        label: "Make a snapshot of this…",
        group: plan ? OPENS_GROUPS.snapshots : undefined,
      })
    if (hidden)
      out.unshift({ value: HIDDEN, label: "Hidden plan", disabled: true })
    // The saved target, before the lists land.
    if (value && !refs.has(value.id))
      out.unshift({ value: value.id, label: opensName({ opens: value })! })
    // Groups stay together: Combobox lists them in first-appearance order.
    const order: (string | undefined)[] = [
      undefined,
      ...Object.values(OPENS_GROUPS),
    ]
    return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
  }, [options, refs, value, hidden, onMakeSnapshot, plan])
  return (
    <Combobox
      aria-label={ariaLabel}
      value={hidden ? HIDDEN : (value?.id ?? null)}
      onChange={(id) => {
        if (id === MAKE_SNAPSHOT) onMakeSnapshot?.()
        else if (id === HIDDEN) return
        else if (!id) onChange(null)
        else onChange(refs.get(id) ?? (value?.id === id ? value : null))
      }}
      options={all}
      noneLabel="Opens nothing"
      placeholder="Pick a floor plan…"
      searchPlaceholder="Search floor plans…"
      emptyText="No floor plans."
    />
  )
}

const isTempId = (id: string) => id.startsWith("new-")

/** Make a live view of `area` (saved) - the "Make a snapshot of this…"
 * row - and answer it. */
function useMakeSnapshot(plan: FloorPlan) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (area: AreaShape) =>
      api<FloorPlanSnapshotResult>(`/api/floor-plans/${plan.id}/snapshot/`, {
        method: "POST",
        body: JSON.stringify({
          name: areaName(area) || "Snapshot",
          area_id: area.id,
          margin: 0,
          mode: "view",
          target: "plan",
        }),
      }),
    onSuccess: (made) => {
      toast.success(`Snapshot ${made.name} made`)
      for (const key of [
        ["floor-plans-picker"],
        ["floor-plans"],
        ["floor-plan-stacks"],
      ])
        void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => apiErrorToast(e),
  })
}

/** Write a shape's Back button: make, move, rename or remove its label. */
export function useBackLink(plan: Pick<FloorPlan, "id">) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      kind: "area" | "label"
      id: string
      on: boolean
      target_id?: string
      text?: string
    }) =>
      api<{ back_label: FloorPlanBackLabelRef | null }>(
        `/api/floor-plans/${plan.id}/back-link/`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["floor-plan-contents"] }),
    onError: (e) => apiErrorToast(e),
  })
}

/** Deleting an area or label whose Back button keeps a label elsewhere:
 * delete that one too, or keep it. */
export function BackLabelDeleteDialog({
  plan,
  shape,
  onClose,
  onDelete,
}: {
  plan: Pick<FloorPlan, "id">
  shape: PlanShape | null
  onClose: () => void
  /** Delete the shape from the draft. */
  onDelete: (id: string) => void
}) {
  const back = useBackLink(plan)
  const bl = shape?.back_label
  return (
    <Dialog open={!!shape} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete its back label too?</DialogTitle>
          <DialogDescription>
            {bl ? `“${bl.text}” on ${bl.floor_plan_name} opens this plan.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (shape) onDelete(shape.id)
              onClose()
            }}
          >
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={back.isPending}
            onClick={() => {
              if (!shape) return
              back.mutate(
                { kind: shape.kind, id: shape.id, on: false },
                {
                  onSuccess: () => {
                    onDelete(shape.id)
                    onClose()
                  },
                }
              )
            }}
          >
            {back.isPending ? "Deleting…" : "Delete both"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Pending =
  | { kind: "move"; to: FloorPlanOpensRef }
  | { kind: "clear" }
  | { kind: "off" }
  | null

/** The Opens row of an area's or label's inspector (and the toolbar's
 * Opens… popover): the picker, a button to open the target, and the Back
 * button with its own text. */
export function OpensEditor({
  plan,
  shape,
  shapes,
  onChange,
  onBackLabel,
}: {
  plan: FloorPlan
  shape: PlanShape
  shapes: readonly PlanShape[]
  onChange: (patch: Partial<PlanShape>) => void
  /** The Back button's label changed on the server: show it (not an edit
   * of this plan). */
  onBackLabel?: (ref: FloorPlanBackLabelRef | null) => void
}) {
  const nav = useNavigate()
  const { canDo } = useMe()
  const back = useBackLink(plan)
  const snapshot = useMakeSnapshot(plan)
  const [pending, setPending] = useState<Pending>(null)
  const bl = shape.back_label ?? null
  const [text, setText] = useState(bl?.text ?? "")
  useEffect(() => setText(bl?.text ?? ""), [shape.id, bl?.text])
  const area = areaUnder(shape, shapes, plan.cell_mm)
  const canSnapshot = canDo("floorplan", "add") && !!area && !isTempId(area.id)
  const saved = !isTempId(shape.id)
  const target = shape.opens ?? null

  const write = (
    body: { on: boolean; target_id?: string; text?: string },
    after?: () => void
  ) =>
    back.mutate(
      { kind: shape.kind, id: shape.id, ...body },
      {
        onSuccess: (r) => {
          onBackLabel?.(r.back_label)
          after?.()
        },
      }
    )

  const pick = (ref: FloorPlanOpensRef | null) => {
    if (bl && ref && ref.id !== target?.id)
      setPending({ kind: "move", to: ref })
    else if (bl && !ref) setPending({ kind: "clear" })
    onChange({ opens: ref, opens_hidden: false })
  }

  const switchTip = !saved
    ? "Save the plan first"
    : target && !target.can_change
      ? `Needs change on ${opensName(shape)}`
      : null
  const toggle = (
    <Switch
      id={`back-${shape.id}`}
      checked={!!bl}
      disabled={!!switchTip || back.isPending}
      onCheckedChange={(on) => {
        if (!target) return
        if (on) write({ on: true, target_id: target.id })
        else setPending({ kind: "off" })
      }}
    />
  )
  const targetName = bl?.floor_plan_name ?? opensName(shape) ?? ""
  return (
    <>
      <Field label="Opens" info="A click on it in View opens this plan.">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <OpensPicker
              plan={plan}
              value={target}
              hidden={!!shape.opens_hidden}
              onChange={pick}
              onMakeSnapshot={
                canSnapshot && !snapshot.isPending
                  ? () =>
                      snapshot.mutate(area, {
                        onSuccess: (made) =>
                          pick({
                            id: made.id,
                            name: made.name,
                            stack_name: made.stack?.name ?? null,
                            kind: made.kind ?? "view",
                            can_change: true,
                          }),
                      })
                  : undefined
              }
            />
          </div>
          {target && (
            <BarIconButton
              label={`Open ${opensName(shape)}`}
              onClick={() =>
                void nav({ to: "/floorplans/$id", params: { id: target.id } })
              }
            >
              <ArrowUpRight />
            </BarIconButton>
          )}
        </div>
      </Field>
      {target && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label
              htmlFor={`back-${shape.id}`}
              className="text-xs whitespace-nowrap"
            >
              Back button
            </Label>
            {switchTip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} data-part="back-tip">
                    {toggle}
                  </span>
                </TooltipTrigger>
                <TooltipContent variant="panel">{switchTip}</TooltipContent>
              </Tooltip>
            ) : (
              toggle
            )}
          </div>
          {bl && (
            <Input
              aria-label="Back button text"
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                const t = text.trim()
                if (t && t !== bl.text)
                  write({ on: true, target_id: target.id, text: t })
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
              }}
            />
          )}
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending?.kind === "move"
            ? `Move the back label to ${opensName({ opens: pending.to })}?`
            : "Remove the back label?"
        }
        description={
          pending?.kind === "move"
            ? `“${bl?.text ?? ""}” on ${targetName} goes to the new plan.`
            : `Deletes “${bl?.text ?? ""}” on ${targetName}.`
        }
        confirmLabel={pending?.kind === "move" ? "Move" : "Remove"}
        pendingLabel={pending?.kind === "move" ? "Moving…" : "Removing…"}
        destructive={pending?.kind !== "move"}
        pending={back.isPending}
        onConfirm={() => {
          const p = pending
          if (!p) return
          if (p.kind === "move")
            write({ on: true, target_id: p.to.id }, () => setPending(null))
          else write({ on: false }, () => setPending(null))
        }}
      />
    </>
  )
}
