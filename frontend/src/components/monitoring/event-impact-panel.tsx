import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MaintenanceEvent, MaintenanceEventImpact } from "@/lib/api"
import { useCustomizationMeta } from "@/lib/custom-fields"
import { Button } from "@/components/ui/button"
import { FormSelect } from "@/components/forms"
import { CfObjectPicker } from "@/components/cf-object-picker"
import { apiErrorToast } from "@/lib/api-toast"
import {
  ObjectRow,
  slugFromObjectType,
} from "@/components/planning/object-chip"

/**
 * What this event touches, and how hard - issue #20's Impact model.
 *
 * Same affordances as a task's linked objects (one frame, quiet rows, add via
 * the customization object picker), plus the level. The server enforces that
 * you can only mark impact on objects you can view.
 */

const LEVELS = [
  { value: "no_impact", label: "No impact" },
  { value: "reduced_redundancy", label: "Reduced redundancy" },
  { value: "degraded", label: "Degraded" },
  { value: "outage", label: "Outage" },
]

const levelTone: Record<string, string> = {
  no_impact: "text-muted-foreground",
  reduced_redundancy: "text-amber-600 dark:text-amber-400",
  degraded: "text-amber-600 dark:text-amber-400",
  outage: "text-red-600 dark:text-red-400",
}

export function EventImpactPanel({ event }: { event: MaintenanceEvent }) {
  const qc = useQueryClient()
  const meta = useCustomizationMeta()
  const [adding, setAdding] = useState(false)
  const [typeSlug, setTypeSlug] = useState<string | null>(null)
  const [objectId, setObjectId] = useState<string | null>(null)
  const [level, setLevel] = useState("outage")

  const refModels = meta.data?.reference_models ?? []
  const refMeta = refModels.find((r) => r.value === typeSlug) ?? null

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["maintenance-events"] })
    qc.invalidateQueries({ queryKey: ["maintenance-event", event.id] })
  }

  const add = useMutation({
    mutationFn: () =>
      api("/api/monitoring/event-impacts/", {
        method: "POST",
        body: JSON.stringify({
          event: event.id,
          object_type: typeSlug,
          object_id: objectId,
          level,
        }),
      }),
    onSuccess: () => {
      toast.success("Impact recorded")
      setAdding(false)
      setTypeSlug(null)
      setObjectId(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/event-impacts/${id}/`, { method: "DELETE" }),
    onSuccess: () => invalidate(),
    onError: (e) => apiErrorToast(e),
  })

  const rows: MaintenanceEventImpact[] = event.impacts

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Impacted objects
          {rows.length > 0 && (
            <span className="num ml-1.5 font-normal">{rows.length}</span>
          )}
        </h3>
        {!adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Mark impact
          </Button>
        )}
      </div>

      {rows.length === 0 && !adding && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-[13px] text-muted-foreground">
          Nothing marked yet. Impacts say which circuits, devices or sites this
          event touches - they show on those objects and on the calendar entry.
        </p>
      )}

      {rows.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {rows.map((impact) => {
            const slug = slugFromObjectType(impact.object_type)
            return (
              <ObjectRow
                key={impact.id}
                slug={slug}
                id={impact.object_id}
                typeLabel={
                  refModels.find((r) => r.value === slug)?.label ?? slug
                }
                action={
                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className={`text-[11px] ${levelTone[impact.level] ?? ""}`}
                    >
                      {LEVELS.find((l) => l.value === impact.level)?.label}
                    </span>
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                      title="Remove impact"
                      onClick={() => remove.mutate(impact.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                }
              />
            )
          })}
        </div>
      )}

      {adding && (
        <div className="grid gap-3 rounded-lg border border-border p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormSelect
              label="Object type"
              value={typeSlug}
              onChange={(v) => {
                setTypeSlug(v)
                setObjectId(null)
              }}
              placeholder="Pick a type"
              options={refModels.map((r) => ({
                value: r.value,
                label: r.label,
              }))}
            />
            <FormSelect
              label="Impact level"
              value={level}
              onChange={(v) => v && setLevel(v)}
              options={LEVELS}
            />
          </div>
          {refMeta && (
            <CfObjectPicker
              refMeta={refMeta}
              label={refMeta.label}
              value={objectId}
              onChange={setObjectId}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!typeSlug || !objectId || add.isPending}
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Marking..." : "Mark impact"}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
