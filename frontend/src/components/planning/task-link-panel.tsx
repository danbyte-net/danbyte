import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link2, Plus, X } from "lucide-react"
import { toast } from "sonner"

import { api, type PlanningTaskLink } from "@/lib/api"
import { useCustomizationMeta } from "@/lib/custom-fields"
import { Button } from "@/components/ui/button"
import { FormSelect } from "@/components/forms"
import { CfObjectPicker } from "@/components/cf-object-picker"
import { apiErrorToast } from "@/lib/api-toast"
import { PlanActions } from "./plan-actions"
import { LinkedDeviceCard } from "./linked-device-card"
import { ObjectRow, objectIcon, slugFromObjectType } from "./object-chip"

/** Attach any registered Danbyte object to a task: pick a type, pick the
 * object, link it.
 *
 * Links render grouped by object type — one card per type with its own icon and
 * count — rather than as a flat chip soup, because a task about four devices
 * and a prefix reads as exactly that. Linked devices additionally show their
 * faceplate, turning the sheet into a picture of the work. */
export function TaskLinkPanel({
  taskId,
  boardId,
  links,
  canEdit,
}: {
  taskId: string
  boardId: string
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

  // Group by type, keeping the registry's own ordering so Devices always sit
  // where Devices sat last time.
  const groups = useMemo(() => {
    const order = new Map(refModels.map((r, i) => [r.value, i]))
    const bySlug = new Map<string, PlanningTaskLink[]>()
    for (const l of links) {
      const slug = slugFromObjectType(l.object_type)
      const bucket = bySlug.get(slug)
      if (bucket) bucket.push(l)
      else bySlug.set(slug, [l])
    }
    return [...bySlug.entries()]
      .map(([slug, items]) => ({
        slug,
        label: refModels.find((r) => r.value === slug)?.label ?? slug,
        items,
      }))
      .sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99))
  }, [links, refModels])

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
          {links.length > 0 && (
            <span className="num ml-1.5 font-normal">{links.length}</span>
          )}
        </h3>
        {canEdit && !adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Link object
          </Button>
        )}
      </div>

      {links.length === 0 && !adding && (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-4">
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            Nothing linked yet. Attach the devices, interfaces, prefixes or
            circuits this task is about and they show up here with their
            faceplates and deep links.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {groups.map((g) => {
          const Icon = objectIcon(g.slug)
          return (
            <div
              key={g.slug}
              className="overflow-hidden rounded-lg border border-border"
            >
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] font-semibold tracking-wide uppercase">
                  {g.label}
                </span>
                <span className="num text-[11px] text-muted-foreground">
                  {g.items.length}
                </span>
              </div>
              <div className="divide-y divide-border">
                {g.items.map((l) => {
                  const removeButton = canEdit && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                      title="Remove link"
                      onClick={() => remove.mutate(l.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )
                  // Devices get the full treatment: faceplate, hardware, IP.
                  const planActions = canEdit && (
                    <PlanActions
                      objectType={l.object_type}
                      objectId={l.object_id}
                      taskId={taskId}
                      boardId={boardId}
                    />
                  )
                  return g.slug === "device" ? (
                    <LinkedDeviceCard
                      key={l.id}
                      deviceId={l.object_id}
                      action={
                        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                          {planActions}
                          {removeButton}
                        </span>
                      }
                    />
                  ) : (
                    <ObjectRow
                      key={l.id}
                      slug={g.slug}
                      id={l.object_id}
                      typeLabel={g.label}
                      note={l.note || undefined}
                      action={
                        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                          {planActions}
                          {removeButton}
                        </span>
                      }
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
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
              {add.isPending ? "Linking..." : "Link"}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
