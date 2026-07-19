import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Cable,
  type CableWritePayload,
  type Paginated,
  type Status,
  type TagOption,
  type TerminationInput,
} from "@/lib/api"
import {
  Field,
  FormColor,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { CableTerminationSide } from "@/components/cable-termination-side"
import { useDcimChoices } from "@/lib/use-dcim-choices"

const LENGTH_UNITS = [
  { value: "m", label: "m" },
  { value: "cm", label: "cm" },
  { value: "ft", label: "ft" },
  { value: "in", label: "in" },
]

export interface CableFormProps {
  cable?: Cable
  /** Pre-seeded A-side terminations (create only) — e.g. "Connect cable"
   * from an interface arrives with that port already on the A end. */
  initialA?: TerminationInput[]
  onSaved: (c: Cable) => void
  onCancel: () => void
}

const toInputs = (terms: Cable["a_terminations"]): TerminationInput[] =>
  terms.map((t) => ({ kind: t.kind, id: t.id }))

export function CableForm({
  cable,
  initialA,
  onSaved,
  onCancel,
}: CableFormProps) {
  const isEdit = !!cable
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [a, setA] = useState<TerminationInput[]>(
    cable ? toInputs(cable.a_terminations) : (initialA ?? [])
  )
  const [b, setB] = useState<TerminationInput[]>(
    cable ? toInputs(cable.b_terminations) : []
  )
  const [label, setLabel] = useState(cable?.label ?? "")
  const [type, setType] = useState(cable?.type ?? "")
  const [statusId, setStatusId] = useState<string | null>(
    cable?.status?.id ?? null
  )
  const [length, setLength] = useState(cable?.length ?? "")
  const [lengthUnit, setLengthUnit] = useState(cable?.length_unit || "m")
  const [color, setColor] = useState(cable?.color ?? "")
  const [description, setDescription] = useState(cable?.description ?? "")
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    cable?.custom_fields ?? {}
  )
  const [tagIds, setTagIds] = useState<number[]>(
    cable?.tags.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!cable) return
    setA(toInputs(cable.a_terminations))
    setB(toInputs(cable.b_terminations))
    setLabel(cable.label)
    setType(cable.type)
    setStatusId(cable.status?.id ?? null)
    setLength(cable.length ?? "")
    setLengthUnit(cable.length_unit || "m")
    setColor(cable.color)
    setDescription(cable.description)
    setTagIds(cable.tags.map((t) => t.id))
    setCustomFields(cable.custom_fields ?? {})
    reset()
  }, [cable, reset])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "cable"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=cable&picker=1"),
    staleTime: 5 * 60_000,
  })

  // A new cable defaults to the "Connected" status (or the first available),
  // so freshly-drawn cables aren't left statusless — a null status can't tint
  // the row or show a badge. Only seeds on create, never overrides an edit or
  // a status the user already picked.
  useEffect(() => {
    if (isEdit || statusId) return
    const opts = statuses.data?.results ?? []
    if (opts.length === 0) return
    const connected = opts.find((s) => s.name.toLowerCase() === "connected")
    setStatusId((connected ?? opts[0]).id)
  }, [isEdit, statusId, statuses.data])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CableWritePayload = {
        a,
        b,
        label: label.trim(),
        type: type.trim(),
        status_id: statusId,
        length: length.trim() === "" ? null : length.trim(),
        length_unit: lengthUnit,
        color: color || "",
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Cable>(`/api/cables/${cable!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Cable>("/api/cables/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["cables"] })
      qc.invalidateQueries({ queryKey: ["cable", saved.id] })
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      toast.success(isEdit ? "Cable updated" : "Cable created")
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const canSubmit = a.length > 0 && b.length > 0

  // Standard cable types; keep any legacy/custom value selectable.
  const cableTypeOptions = [...choices.cable_types]
  if (type && !cableTypeOptions.some((o) => o.value === type)) {
    cableTypeOptions.unshift({ value: type, label: type })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) mutation.mutate()
      }}
      className="grid gap-4"
    >
      <CableTerminationSide
        label="A side"
        hint="One or more ports — breakout uses 1 here, many on B"
        error={fieldErrors.a}
        value={a}
        onChange={setA}
        initialTerminations={cable?.a_terminations}
      />
      <CableTerminationSide
        label="B side"
        error={fieldErrors.b}
        value={b}
        onChange={setB}
        initialTerminations={cable?.b_terminations}
      />

      <FormText
        label="Label"
        hint="What's printed on the cable's physical tag (optional)."
        value={label}
        onChange={setLabel}
        error={fieldErrors.label}
      />

      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Type"
          value={type || null}
          onChange={(v) => setType(v ?? "")}
          noneLabel="No type"
          placeholder="Pick a type"
          searchPlaceholder="Search types…"
          emptyText="No types."
          options={cableTypeOptions}
          error={fieldErrors.type}
        />
        <FormCombobox
          label="Status"
          value={statusId}
          onChange={setStatusId}
          options={(statuses.data?.results ?? []).map((s) => ({
            value: s.id,
            label: s.name,
          }))}
          noneLabel="No status"
          placeholder="Select a status…"
          error={fieldErrors.status_id}
        />
      </div>
      <div className="grid grid-cols-[1fr_120px] gap-3">
        <FormText
          label="Length"
          type="number"
          value={length}
          onChange={setLength}
          error={fieldErrors.length}
        />
        <FormSelect
          label="Unit"
          value={lengthUnit}
          onChange={(v) => v && setLengthUnit(v)}
          options={LENGTH_UNITS}
        />
      </div>
      <FormColor
        label="Color"
        hint="The physical cable's color"
        value={color}
        onChange={setColor}
        error={fieldErrors.color}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <CustomFieldInputs
        model="cable"
        value={customFields}
        onChange={setCustomFields}
      />

      {!canSubmit && (
        <p className="text-[11px] text-muted-foreground">
          Add at least one port to each side.
        </p>
      )}
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cable"}
      />
    </form>
  )
}
