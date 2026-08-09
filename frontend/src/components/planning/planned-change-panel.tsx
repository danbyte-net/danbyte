import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CalendarClock, Check, Plus, TriangleAlert, X } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  ApiError,
  type PlanningPlannedChange,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { useEditableFields, useEditableModels } from "@/lib/use-editable-fields"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import {
  FieldEditor,
  FormDate,
  FormSelect,
  FormText,
  useFieldEditorOptions,
} from "@/components/forms"
import { CfObjectPicker } from "@/components/cf-object-picker"
import { useCustomizationMeta } from "@/lib/custom-fields"
import { apiErrorToast } from "@/lib/api-toast"
import { ObjectRow, objectIcon, slugFromObjectType } from "./object-chip"

/** Planned changes on a task: what will change, on which object, when.
 *
 * Grouped by target object rather than by type, because that is how the work
 * reads — "on sw-01, two things change". Applying writes the value into
 * Danbyte's record; it does not push configuration to the device. */
export function PlannedChangePanel({
  task,
  canEdit,
}: {
  task: PlanningTask
  canEdit: boolean
}) {
  const changes = task.planned_changes ?? []
  const [adding, setAdding] = useState(false)
  const { canDo } = useMe()
  const meta = useCustomizationMeta()

  const groups = useMemo(() => {
    const by = new Map<string, PlanningPlannedChange[]>()
    for (const c of changes) {
      const key = `${c.object_type}|${c.object_id}`
      const hit = by.get(key)
      if (hit) hit.push(c)
      else by.set(key, [c])
    }
    return [...by.values()]
  }, [changes])

  const open = changes.filter((c) => c.state === "planned").length

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Planned changes
          {changes.length > 0 && (
            <span className="num ml-1.5 font-normal">
              {open > 0 ? `${open} open` : `${changes.length}`}
            </span>
          )}
        </h3>
        {canEdit && !adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Plan a change
          </Button>
        )}
      </div>

      {changes.length === 0 && !adding && (
        <div className="flex items-start gap-3 rounded-lg border border-dashed border-border px-3 py-4">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            Nothing planned yet. Declare what this task will change — an
            interface going down, a device moving to Decommissioning — and the
            object's own page will warn that a change is coming. Applying
            updates Danbyte's record, not the device.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {groups.map((rows) => (
          <TargetGroup
            key={`${rows[0].object_type}|${rows[0].object_id}`}
            rows={rows}
            typeLabel={
              meta.data?.reference_models.find(
                (r) => r.value === slugFromObjectType(rows[0].object_type)
              )?.label ?? slugFromObjectType(rows[0].object_type)
            }
            canEdit={canEdit}
            canApply={canDo(slugFromObjectType(rows[0].object_type), "change")}
          />
        ))}
      </div>

      {adding && <PlanForm taskId={task.id} onDone={() => setAdding(false)} />}
    </section>
  )
}

/** One target object and everything this task changes on it. Resolves the
 * field labels once per target so rows read "Status", not "status_id". */
function TargetGroup({
  rows,
  typeLabel,
  canEdit,
  canApply,
}: {
  rows: PlanningPlannedChange[]
  typeLabel: string
  canEdit: boolean
  canApply: boolean
}) {
  const slug = slugFromObjectType(rows[0].object_type)
  const { fields } = useEditableFields(slug)
  const labelFor = (key: string) =>
    fields.find((f) => f.spec.key === key)?.spec.label ?? key

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <ObjectRow slug={slug} id={rows[0].object_id} typeLabel={typeLabel} />
      <div className="divide-y divide-border border-t border-border">
        {rows.map((c) => (
          <ChangeRow
            key={c.id}
            change={c}
            fieldLabel={labelFor(c.field)}
            canEdit={canEdit}
            canApply={canApply}
          />
        ))}
      </div>
    </div>
  )
}

function ChangeRow({
  change: c,
  fieldLabel,
  canEdit,
  canApply,
}: {
  change: PlanningPlannedChange
  fieldLabel: string
  canEdit: boolean
  canApply: boolean
}) {
  const qc = useQueryClient()
  const { formatDate, today } = useDateFormat()

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["planning-tasks"] })
    qc.invalidateQueries({ queryKey: ["planned-changes-map"] })
  }

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(`/api/planning/planned-changes/${c.id}/${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    onSuccess: () => invalidate(),
  })

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/planning/planned-changes/${c.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Plan removed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  /** A 409 means the object moved since we planned; offer to overwrite. */
  const applyNow = () =>
    act.mutate(
      { path: "apply/" },
      {
        onSuccess: () => toast.success("Change applied"),
        onError: (e) => {
          const conflict =
            e instanceof ApiError && e.status === 409
              ? (e.body as { current_display?: string } | undefined)
              : undefined
          if (!conflict) return apiErrorToast(e)
          const now = conflict.current_display || "empty"
          if (
            window.confirm(
              `The value changed since this was planned — it is now "${now}".\n\n` +
                `Apply anyway and overwrite it?`
            )
          ) {
            act.mutate(
              { path: "apply/", body: { force: true } },
              {
                onSuccess: () => toast.success("Change applied"),
                onError: (err) => apiErrorToast(err),
              }
            )
          }
        },
      }
    )

  const done = c.state !== "planned"
  const due = c.effective_date
  const overdue = !!due && !done && due < today

  return (
    <div className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span
        className={`min-w-0 flex-1 text-[13px] ${done ? "text-muted-foreground" : ""}`}
      >
        <span className="font-medium">{fieldLabel}</span>{" "}
        <span
          className={
            c.state === "cancelled" ? "line-through" : "text-muted-foreground"
          }
        >
          {c.current_display || "—"}
        </span>
        <span className="text-muted-foreground"> → </span>
        <span
          className={c.state === "cancelled" ? "line-through" : "font-medium"}
        >
          {c.new_display || "—"}
        </span>
      </span>

      {c.stale && !done && (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
          title="The object's live value changed since this was planned."
        >
          <TriangleAlert className="h-3 w-3" /> changed since planned
        </span>
      )}

      {due && !done && (
        <span
          className={`inline-flex items-center gap-1 text-[11px] ${
            overdue ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
          }`}
          title={
            c.planned_for
              ? "This change's own date"
              : "From the task's due date"
          }
        >
          <CalendarClock className="h-3 w-3" /> {formatDate(due)}
        </span>
      )}

      {c.state === "applied" && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Check className="h-3 w-3" /> Applied
          {c.applied_by_username ? ` by ${c.applied_by_username}` : ""}
          {c.applied_at ? " · " : ""}
          {c.applied_at && <TimeCell iso={c.applied_at} />}
        </span>
      )}
      {c.state === "cancelled" && (
        <span className="text-[11px] text-muted-foreground">Cancelled</span>
      )}

      {!done && canEdit && (
        <span className="flex shrink-0 items-center gap-1">
          {canApply && (
            <Button
              size="sm"
              variant="secondary"
              disabled={act.isPending}
              onClick={applyNow}
            >
              {act.isPending ? "Applying..." : "Apply"}
            </Button>
          )}
          <button
            type="button"
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
            title="Remove this plan"
            onClick={() => remove.mutate()}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </div>
  )
}

function PlanForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const qc = useQueryClient()
  const meta = useCustomizationMeta()
  const { models } = useEditableModels()
  const [slug, setSlug] = useState<string | null>(null)
  const [objectId, setObjectId] = useState<string | null>(null)
  const [fieldKey, setFieldKey] = useState<string | null>(null)
  const [value, setValue] = useState<unknown>(undefined)
  const [plannedFor, setPlannedFor] = useState("")
  const [note, setNote] = useState("")

  const { fields } = useEditableFields(slug)
  const chosen = fields.find((f) => f.spec.key === fieldKey) ?? null
  const specs = useMemo(() => fields.map((f) => f.spec), [fields])
  const options = useFieldEditorOptions(specs)

  // Only offer types the object picker can actually resolve.
  const refModels = meta.data?.reference_models ?? []
  const typeOptions = models
    .filter((m) => refModels.some((r) => r.value === m.slug))
    .map((m) => ({ value: m.slug, label: m.label }))
  const refMeta = refModels.find((r) => r.value === slug) ?? null

  const create = useMutation({
    mutationFn: () =>
      api("/api/planning/planned-changes/", {
        method: "POST",
        body: JSON.stringify({
          task: taskId,
          object_type: slug,
          object_id: objectId,
          field: fieldKey,
          new_value: value ?? null,
          planned_for: plannedFor || null,
          note,
        }),
      }),
    onSuccess: () => {
      toast.success("Change planned")
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      qc.invalidateQueries({ queryKey: ["planned-changes-map"] })
      onDone()
    },
    onError: (e) => apiErrorToast(e),
  })

  const Icon = slug ? objectIcon(slug) : CalendarClock

  return (
    <div className="grid gap-3 rounded-lg border border-border p-3">
      <FormSelect
        label="Object type"
        value={slug}
        onChange={(v) => {
          setSlug(v)
          setObjectId(null)
          setFieldKey(null)
          setValue(undefined)
        }}
        placeholder="Pick a type"
        options={typeOptions}
        hint="Only types Danbyte will accept field-level writes for."
      />

      {refMeta && (
        <CfObjectPicker
          refMeta={refMeta}
          label={refMeta.label}
          value={objectId}
          onChange={setObjectId}
        />
      )}

      {slug && objectId && (
        <FormSelect
          label="Field"
          value={fieldKey}
          onChange={(v) => {
            setFieldKey(v)
            setValue(undefined)
          }}
          placeholder="Pick a field"
          options={fields.map((f) => ({
            value: f.spec.key,
            label: f.spec.label,
          }))}
        />
      )}

      {chosen && (
        <FieldEditor
          spec={chosen.spec}
          mode="always"
          value={value}
          onChange={setValue}
          options={options}
        />
      )}

      {chosen && (
        <>
          <FormDate
            label="Implementation date"
            value={plannedFor}
            onChange={setPlannedFor}
            hint="Optional. Empty means whenever the task is due."
          />
          <FormText
            label="Note"
            value={note}
            onChange={setNote}
            placeholder="optional"
          />
        </>
      )}

      <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Nothing changes until someone applies this. Applying writes the value
        into Danbyte's record — it does not push configuration to the device.
      </p>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            !slug ||
            !objectId ||
            !fieldKey ||
            value === undefined ||
            create.isPending
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Planning..." : "Plan change"}
        </Button>
      </div>
    </div>
  )
}
