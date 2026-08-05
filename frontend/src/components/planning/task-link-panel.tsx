import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"

import { api, type PlanningTaskLink } from "@/lib/api"
import { useCustomizationMeta } from "@/lib/custom-fields"
import { Button } from "@/components/ui/button"
import { FormSelect } from "@/components/forms"
import { CfObjectPicker } from "@/components/cf-object-picker"
import { apiErrorToast } from "@/lib/api-toast"
import { ObjectChip, slugFromObjectType } from "./object-chip"

/** Attach any registered Danbyte object to a task: pick a type, pick the
 * object, link it. Existing links render as label chips that deep-link to the
 * object's detail page. */
export function TaskLinkPanel({
  taskId,
  links,
  canEdit,
}: {
  taskId: string
  links: PlanningTaskLink[]
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const meta = useCustomizationMeta()
  const [adding, setAdding] = useState(false)
  const [typeSlug, setTypeSlug] = useState<string | null>(null)
  const [objectId, setObjectId] = useState<string | null>(null)

  const refModels = meta.data?.reference_models ?? []
  const refMeta = refModels.find((r) => r.value === typeSlug) ?? null

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["planning-tasks"] })
    qc.invalidateQueries({ queryKey: ["planning-task", taskId] })
  }

  const add = useMutation({
    mutationFn: () =>
      api("/api/planning/links/", {
        method: "POST",
        body: JSON.stringify({
          task: taskId,
          object_type: typeSlug,
          object_id: objectId,
        }),
      }),
    onSuccess: () => {
      toast.success("Linked")
      setAdding(false)
      setTypeSlug(null)
      setObjectId(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/planning/links/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Link removed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Linked objects
        </h3>
        {canEdit && !adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Link object
          </Button>
        )}
      </div>

      {links.length === 0 && !adding && (
        <p className="text-[13px] text-muted-foreground">
          Nothing linked yet. Attach the devices, prefixes or circuits this task
          is about.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1">
            <ObjectChip
              slug={slugFromObjectType(l.object_type)}
              id={l.object_id}
            />
            {canEdit && (
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="Remove link"
                onClick={() => remove.mutate(l.id)}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>

      {adding && (
        <div className="grid gap-3 rounded-lg border border-border p-3">
          <FormSelect
            label="Object type"
            value={typeSlug}
            onChange={(v) => {
              setTypeSlug(v)
              setObjectId(null)
            }}
            placeholder="Pick a type"
            options={refModels.map((r) => ({ value: r.value, label: r.label }))}
          />
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
              {add.isPending ? "Linking…" : "Link"}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
