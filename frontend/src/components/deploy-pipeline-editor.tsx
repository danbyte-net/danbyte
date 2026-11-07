import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Copy, Download, GripVertical, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api, ApiError } from "@/lib/api"
import type {
  AutomationTarget,
  DeployPipeline,
  DeployPipelineCode,
  DeployPipelineWritePayload,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { copyWithToast } from "@/lib/clipboard"
import { downloadBlob } from "@/lib/table-export"
import { pipelineToYaml } from "@/lib/pipeline-code"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { AutomationTargetPicker } from "@/components/automation-target-picker"

export const PIPELINE_OBJECT_TYPES = [
  { value: "device", label: "Device" },
  { value: "virtualmachine", label: "Virtual machine" },
]

export function objectTypeLabel(slug: string): string {
  return PIPELINE_OBJECT_TYPES.find((o) => o.value === slug)?.label ?? slug
}

interface DraftStep {
  key: string
  target: string | null
  stop_on_failure: boolean
  wait_for_result: boolean
  timeout_minutes: string
}

type StepErrors = Record<string, string>[]

let seq = 0
const newKey = () => `s${++seq}`

function draftFrom(p?: DeployPipeline): DraftStep[] {
  if (!p || p.steps.length === 0)
    return [
      {
        key: newKey(),
        target: null,
        stop_on_failure: true,
        wait_for_result: false,
        timeout_minutes: "30",
      },
    ]
  return p.steps.map((s) => ({
    key: newKey(),
    target: s.target,
    stop_on_failure: s.stop_on_failure,
    wait_for_result: s.wait_for_result,
    timeout_minutes: String(s.timeout_minutes),
  }))
}

/** What the step's target kind means for the step, in a few words. */
function kindNote(t: AutomationTarget | undefined): string {
  if (!t) return ""
  if (t.kind === "script")
    return `Runs ${t.script_name ?? "a script"}; the next step starts when it ends.`
  if (t.kind === "webhook")
    return "Signed POST; done once accepted, or when its result is reported."
  return "Launched on the runner; done once launched."
}

export interface DeployPipelineEditorProps {
  pipeline?: DeployPipeline
  onSaved: (p: DeployPipeline) => void
  onCancel: () => void
}

/** Create or edit a pipeline: details, steps as draggable cards, and a flow
 * preview with the same pipeline as code beside them. */
export function DeployPipelineEditor({
  pipeline,
  onSaved,
  onCancel,
}: DeployPipelineEditorProps) {
  const isEdit = !!pipeline
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [stepErrors, setStepErrors] = useState<StepErrors>([])

  const [name, setName] = useState(pipeline?.name ?? "")
  const [objectType, setObjectType] = useState(
    pipeline?.object_types[0] ?? "device"
  )
  const [description, setDescription] = useState(pipeline?.description ?? "")
  const [autoOnChange, setAutoOnChange] = useState(
    pipeline?.auto_on_change ?? false
  )
  const [enabled, setEnabled] = useState(pipeline?.enabled ?? true)
  const [roles, setRoles] = useState<string[]>(pipeline?.roles ?? [])
  const [steps, setSteps] = useState<DraftStep[]>(() => draftFrom(pipeline))

  const targets = useQuery({
    queryKey: ["automation-targets", "enabled"],
    queryFn: () => apiAll<AutomationTarget>("/api/automation-targets/"),
    staleTime: 60_000,
  })
  const byId = useMemo(
    () => new Map((targets.data?.results ?? []).map((t) => [t.id, t])),
    [targets.data]
  )
  const roleOptions = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      apiAll<{ id: string; name: string; color?: string }>(
        "/api/device-roles/?picker=1"
      ),
    staleTime: 10 * 60_000,
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setSteps((prev) => {
      const from = prev.findIndex((s) => s.key === active.id)
      const to = prev.findIndex((s) => s.key === over.id)
      if (from < 0 || to < 0) return prev
      return arrayMove(prev, from, to)
    })
    setStepErrors([])
  }
  const patch = (key: string, p: Partial<DraftStep>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)))

  const code: DeployPipelineCode = {
    name: name.trim() || "Untitled",
    description: description.trim() || undefined,
    object_types: [objectType],
    auto_on_change: autoOnChange,
    enabled,
    roles: (roleOptions.data?.results ?? [])
      .filter((r) => roles.includes(r.id))
      .map((r) => r.name),
    steps: steps.map((s) => ({
      target: (s.target && byId.get(s.target)?.name) || "(pick a target)",
      stop_on_failure: s.stop_on_failure,
      wait_for_result: s.wait_for_result,
      timeout_minutes: Number(s.timeout_minutes) || 30,
    })),
  }
  const yaml = pipelineToYaml(code)

  const save = useMutation({
    mutationFn: () => {
      const payload: DeployPipelineWritePayload = {
        name: name.trim(),
        description: description.trim(),
        object_types: [objectType],
        auto_on_change: autoOnChange,
        enabled,
        roles,
        steps: steps.map((s) => ({
          target: s.target ?? "",
          stop_on_failure: s.stop_on_failure,
          wait_for_result: s.wait_for_result,
          timeout_minutes: Number(s.timeout_minutes) || 30,
        })),
      }
      return api<DeployPipeline>(
        isEdit
          ? `/api/deploy-pipelines/${pipeline.id}/`
          : "/api/deploy-pipelines/",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        }
      )
    },
    onSuccess: (saved) => {
      reset()
      setStepErrors([])
      qc.invalidateQueries({ queryKey: ["deploy-pipelines"] })
      qc.invalidateQueries({ queryKey: ["deploy-pipeline", saved.id] })
      toast.success(isEdit ? `Saved ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        Array.isArray((err.body as { steps?: unknown }).steps)
      ) {
        const raw = (err.body as { steps: unknown[] }).steps
        setStepErrors(
          raw.map((e) => {
            const out: Record<string, string> = {}
            if (e && typeof e === "object")
              for (const [k, v] of Object.entries(e))
                out[k] = Array.isArray(v) ? String(v[0]) : String(v)
            return out
          })
        )
      } else setStepErrors([])
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const stepsError =
    fieldErrors.steps && !fieldErrors.steps.startsWith("[")
      ? fieldErrors.steps
      : undefined

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="@container grid gap-4"
    >
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <div className="grid min-w-0 content-start gap-4">
          <FormSection title="Pipeline" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Name"
                required
                autoFocus={!isEdit}
                value={name}
                onChange={setName}
                error={fieldErrors.name}
              />
              <FormSelect
                label="Applies to"
                value={objectType}
                onChange={(v) => setObjectType(v ?? "device")}
                options={PIPELINE_OBJECT_TYPES}
                error={fieldErrors.object_types}
              />
            </div>
            <FormTextarea
              label="Description"
              rows={2}
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <FormCheckbox
                label="Run on change"
                checked={autoOnChange}
                onChange={setAutoOnChange}
                hint="When a matching object is saved, as its author"
              />
              <FormCheckbox
                label="Enabled"
                checked={enabled}
                onChange={setEnabled}
              />
            </div>
            <Field
              label="Default for roles"
              info="The Deploy dialog preselects this pipeline for a device or VM with one of these roles."
              error={fieldErrors.roles}
              group
            >
              <CheckList
                options={(roleOptions.data?.results ?? []).map((r) => ({
                  value: r.id,
                  label: r.name,
                  color: r.color ?? null,
                }))}
                value={roles}
                onChange={setRoles}
                empty="No roles."
              />
            </Field>
          </FormSection>

          <FormSection title="Steps" card>
            <p className="text-xs text-muted-foreground">Drag to reorder.</p>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={steps.map((s) => s.key)}
                strategy={verticalListSortingStrategy}
              >
                <div className="grid gap-2">
                  {steps.map((s, i) => (
                    <StepCard
                      key={s.key}
                      step={s}
                      index={i}
                      target={s.target ? byId.get(s.target) : undefined}
                      errors={stepErrors[i] ?? {}}
                      canRemove={steps.length > 1}
                      onChange={(p) => patch(s.key, p)}
                      onRemove={() => {
                        setSteps((prev) => prev.filter((x) => x.key !== s.key))
                        setStepErrors([])
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {stepsError && (
              <p className="text-xs text-destructive">{stepsError}</p>
            )}
            <Button
              type="button"
              variant="outline"
              className="w-full border-dashed"
              onClick={() =>
                setSteps((prev) => [
                  ...prev,
                  {
                    key: newKey(),
                    target: null,
                    stop_on_failure: true,
                    wait_for_result: false,
                    timeout_minutes: "30",
                  },
                ])
              }
            >
              <Plus className="size-3.5" /> Add step
            </Button>
          </FormSection>
        </div>

        <aside className="grid min-w-0 content-start gap-4">
          <FormSection title="Flow" card>
            <PipelineFlow
              trigger={
                autoOnChange
                  ? `Deploy on a ${objectTypeLabel(objectType).toLowerCase()}, or a change`
                  : `Deploy on a ${objectTypeLabel(objectType).toLowerCase()}`
              }
              steps={steps.map((s) => {
                const t = s.target ? byId.get(s.target) : undefined
                return {
                  name: t?.name ?? "Pick a target",
                  kind: t?.kind_display,
                }
              })}
            />
          </FormSection>
          <PipelineCodeCard yaml={yaml} filename={`${code.name}.yaml`} />
        </aside>
      </div>

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save pipeline" : "Create pipeline"}
      />
    </form>
  )
}

function StepCard({
  step,
  index,
  target,
  errors,
  canRemove,
  onChange,
  onRemove,
}: {
  step: DraftStep
  index: number
  target: AutomationTarget | undefined
  errors: Record<string, string>
  canRemove: boolean
  onChange: (p: Partial<DraftStep>) => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.key })
  const waitable = target?.kind === "webhook"
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-card p-3",
        isDragging && "relative z-10 shadow-md"
      )}
    >
      <button
        type="button"
        className="mt-7 cursor-grab touch-none text-muted-foreground/60 hover:text-foreground"
        aria-label={`Drag step ${index + 1}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <Badge variant="info" className="num mt-7 min-w-6 justify-center">
        {index + 1}
      </Badge>
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <AutomationTargetPicker
              label="Target"
              required
              value={step.target}
              onChange={(v) => onChange({ target: v })}
              error={errors.target}
            />
          </div>
          {target && (
            <Badge variant="outline" className="mb-2 text-[10px]">
              {target.kind_display}
            </Badge>
          )}
        </div>
        {target && (
          <p className="text-xs text-muted-foreground">{kindNote(target)}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <FormCheckbox
            label="Stop the pipeline if this step fails"
            checked={step.stop_on_failure}
            onChange={(v) => onChange({ stop_on_failure: v })}
          />
          <FormCheckbox
            label="Wait for a reported result"
            checked={target?.kind === "script" ? true : step.wait_for_result}
            disabled={!waitable}
            info={
              target?.kind === "script"
                ? "A script step always waits for its run to end."
                : "The runner posts its result to /api/deploy-runs/<id>/result/."
            }
            onChange={(v) => onChange({ wait_for_result: v })}
          />
        </div>
        {errors.wait_for_result && (
          <p className="text-xs text-destructive">{errors.wait_for_result}</p>
        )}
        {waitable && step.wait_for_result && (
          <div className="w-40">
            <FormText
              label="Timeout, minutes"
              type="number"
              min={1}
              value={step.timeout_minutes}
              onChange={(v) => onChange({ timeout_minutes: v })}
              error={errors.timeout_minutes}
            />
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="mt-6 h-7 w-7 text-muted-foreground hover:text-destructive"
        aria-label={`Remove step ${index + 1}`}
        disabled={!canRemove}
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

/** The trigger, then each step, joined by a line. */
export function PipelineFlow({
  trigger,
  steps,
}: {
  trigger: string
  steps: { name: string; kind?: string }[]
}) {
  return (
    <ol className="flex flex-col">
      <li className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
        {trigger}
      </li>
      {steps.map((s, i) => (
        <li key={i} className="flex flex-col">
          <span aria-hidden className="ml-5 h-4 w-0.5 bg-border" />
          <span className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <span className="num font-medium">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {s.kind && (
              <span className="shrink-0 text-muted-foreground">{s.kind}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The pipeline as YAML, to copy or download. */
export function PipelineCodeCard({
  yaml,
  filename,
}: {
  yaml: string
  filename: string
}) {
  return (
    <FormSection title="As code" card>
      <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-[12px] leading-relaxed">
        {yaml}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copyWithToast(yaml, "Copied")}
        >
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            downloadBlob(
              filename.replace(/[^\w.() -]+/g, "_"),
              "application/yaml",
              yaml
            )
          }
        >
          <Download className="size-3.5" /> Download
        </Button>
      </div>
    </FormSection>
  )
}
