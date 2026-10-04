import { useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { syncCabinetFromType } from "@/lib/api"
import type {
  Cabinet,
  CabinetSizes,
  CabinetSyncDiff,
  CabinetSyncRailField,
  DinProfile,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { cabinetTypeLabel, invalidateCabinetViews } from "@/lib/cabinets"
import { PROFILE_LABELS } from "@/lib/din-geometry"
import { invalidateObjectQueries } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const SIZE_LABEL: Record<keyof CabinetSizes, string> = {
  inner_width_mm: "Plate width",
  inner_height_mm: "Plate height",
  outer_width_mm: "Outer width",
  outer_height_mm: "Outer height",
  outer_depth_mm: "Outer depth",
}

const RAIL_FIELD_LABEL: Record<CabinetSyncRailField, string> = {
  profile: "Profile",
  x_mm: "Left end",
  y_mm: "Centreline",
  length_mm: "Length",
}
const RAIL_FIELDS = Object.keys(RAIL_FIELD_LABEL) as CabinetSyncRailField[]

const mm = (v: number | string | null) => (v == null ? "-" : `${v} mm`)

const railValue = (field: CabinetSyncRailField, v: number | string) =>
  field === "profile"
    ? ((PROFILE_LABELS[v as DinProfile] as string | undefined) ?? String(v))
    : mm(v)

/**
 * Re-align a cabinet with its type - the cabinet twin of the rack's Sync
 * type. Dry run first: the dialog shows the sizes that differ and the rails
 * the type would add or move before anything is written. Rails the type
 * does not name are reported and left alone; a sync never removes one. A
 * move the devices on a rail would not survive is listed as blocked, with
 * the reason, and skipped.
 */
export function CabinetSyncTypeButton({ cabinet }: { cabinet: Cabinet }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [diff, setDiff] = useState<CabinetSyncDiff | null>(null)
  const [withSizes, setWithSizes] = useState(true)
  const [withRails, setWithRails] = useState(true)

  const check = useMutation({
    mutationFn: () => syncCabinetFromType(cabinet.id),
    onSuccess: (r) => {
      setWithSizes(true)
      setWithRails(true)
      setDiff(r.diff)
    },
    onError: (err) => apiErrorToast(err),
  })

  const apply = useMutation({
    mutationFn: (parts: { sizes: boolean; rails: boolean }) =>
      syncCabinetFromType(cabinet.id, { apply: true, ...parts }),
    onSuccess: (_r, parts) => {
      invalidateCabinetViews(qc)
      invalidateObjectQueries(qc, cabinet.id)
      const sized = parts.sizes ? Object.keys(diff?.sizes ?? {}).length : 0
      const added = parts.rails ? (diff?.rails?.add ?? []) : []
      const moved = parts.rails
        ? (diff?.rails?.update ?? []).map((u) => u.label)
        : []
      const done = [
        added.length ? `added ${added.join(", ")}` : "",
        moved.length ? `moved ${moved.join(", ")}` : "",
        sized ? `${sized} size${sized === 1 ? "" : "s"}` : "",
      ].filter(Boolean)
      toast.success(
        done.length ? `Synced - ${done.join(" · ")}` : "Nothing to change"
      )
      setDiff(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!cabinet.cabinet_type || !canDo("cabinet", "change")) return null

  const sizes = Object.entries(diff?.sizes ?? {}) as [
    keyof CabinetSizes,
    { cabinet: number | null; type: number | null },
  ][]
  const add = diff?.rails?.add ?? []
  const update = diff?.rails?.update ?? []
  const blocked = diff?.rails?.blocked ?? []
  const extra = diff?.rails?.extra ?? []
  const hasSizes = sizes.length > 0
  const hasRails = add.length > 0 || update.length > 0
  // Nothing to apply - which is not the same as matching the type while a
  // blocked move is outstanding.
  const inStep = !hasSizes && !hasRails
  // Both parts differ: each can be left out.
  const pick = hasSizes && hasRails
  const sizesOn = hasSizes && (!pick || withSizes)
  const railsOn = hasRails && (!pick || withRails)

  const close = () => {
    if (!apply.isPending) setDiff(null)
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={check.isPending}
        onClick={() => check.mutate()}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {check.isPending ? "Checking…" : "Sync from type"}
      </Button>

      <Dialog open={!!diff} onOpenChange={(o) => !o && close()}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              Sync with {cabinetTypeLabel(cabinet.cabinet_type)}
            </DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 text-sm">
            {inStep && blocked.length === 0 && (
              <p className="text-muted-foreground">
                This cabinet matches its type.
              </p>
            )}

            {hasSizes && (
              <Part
                title="Sizes"
                checked={pick ? withSizes : undefined}
                onCheckedChange={setWithSizes}
              >
                {sizes.map(([field, v]) => (
                  <Change
                    key={field}
                    label={SIZE_LABEL[field]}
                    from={mm(v.cabinet)}
                    to={mm(v.type)}
                  />
                ))}
              </Part>
            )}

            {hasRails && (
              <Part
                title="Rails"
                checked={pick ? withRails : undefined}
                onCheckedChange={setWithRails}
              >
                {add.length > 0 && (
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-28 text-muted-foreground">Add</span>
                    <span>{add.join(", ")}</span>
                  </div>
                )}
                {update.map((u) =>
                  RAIL_FIELDS.flatMap((field) => {
                    const v = u.changes[field]
                    return v
                      ? [
                          <Change
                            key={`${u.label}-${field}`}
                            label={`${u.label} ${RAIL_FIELD_LABEL[field].toLowerCase()}`}
                            from={railValue(field, v.cabinet)}
                            to={railValue(field, v.type)}
                          />,
                        ]
                      : []
                  })
                )}
              </Part>
            )}

            {blocked.length > 0 && (
              <Part title="Blocked, kept">
                {blocked.map((b) => (
                  <div key={b.label} data-blocked={b.label} className="grid">
                    {RAIL_FIELDS.flatMap((field) => {
                      const v = b.changes[field]
                      return v
                        ? [
                            <Change
                              key={field}
                              label={`${b.label} ${RAIL_FIELD_LABEL[field].toLowerCase()}`}
                              from={railValue(field, v.cabinet)}
                              to={railValue(field, v.type)}
                              kept
                            />,
                          ]
                        : []
                    })}
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {b.reason}
                    </p>
                  </div>
                ))}
              </Part>
            )}

            {extra.length > 0 && (
              <Part title="Not on the type, kept">
                <span>{extra.join(", ")}</span>
              </Part>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={apply.isPending}>
              {inStep ? "Close" : "Cancel"}
            </Button>
            {!inStep && (
              <Button
                disabled={apply.isPending || (!sizesOn && !railsOn)}
                onClick={() => apply.mutate({ sizes: sizesOn, rails: railsOn })}
              >
                {apply.isPending ? "Applying…" : "Apply"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** One part of the difference, under its heading; with `checked`, the
 * heading carries the box that leaves the part out. */
function Part({
  title,
  checked,
  onCheckedChange,
  children,
}: {
  title: string
  checked?: boolean
  onCheckedChange?: (v: boolean) => void
  children: ReactNode
}) {
  const heading = (
    <span className="text-[10px] font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
      {title}
    </span>
  )
  return (
    <div className="grid gap-1">
      {checked === undefined ? (
        heading
      ) : (
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={checked}
            onCheckedChange={(v) => onCheckedChange?.(!!v)}
            aria-label={`Apply ${title.toLowerCase()}`}
          />
          {heading}
        </label>
      )}
      {children}
    </div>
  )
}

/** "Plate width   500 mm → 525 mm", the old value struck through - or,
 * `kept`, the old value standing and the type's muted. */
function Change({
  label,
  from,
  to,
  kept,
}: {
  label: string
  from: string
  to: string
  kept?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="min-w-28 whitespace-nowrap text-muted-foreground">
        {label}
      </span>
      <span className={kept ? "num" : "num text-muted-foreground line-through"}>
        {from}
      </span>
      <span className={kept ? "num text-muted-foreground" : "num"}>→ {to}</span>
    </div>
  )
}
