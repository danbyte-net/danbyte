import { useQuery } from "@tanstack/react-query"

import { api, type CustomField, type Paginated } from "@/lib/api"
import { groupCustomFields, useCustomizationMeta } from "@/lib/custom-fields"
import { CfObjectPicker } from "@/components/cf-object-picker"
import {
  Field,
  FormCheckbox,
  FormSelect,
  FormText,
  FormTextarea,
} from "@/components/forms"
import { Input } from "@/components/ui/input"

export interface CustomFieldInputsProps {
  /** Model slug, e.g. "prefix" — must match the field's applies_to. */
  model: string
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

// Renders the active tenant's custom fields for `model` as typed inputs that
// read/write into the object's `custom_fields` dict. Renders nothing when the
// tenant has declared no fields for this model.
export function CustomFieldInputs({
  model,
  value,
  onChange,
}: CustomFieldInputsProps) {
  const q = useQuery({
    queryKey: ["custom-fields-for", model],
    queryFn: () =>
      api<Paginated<CustomField>>(`/api/custom-fields/?model=${model}`),
    staleTime: 5 * 60_000,
  })
  const defs = q.data?.results ?? []
  if (defs.length === 0) return null

  const set = (key: string, v: unknown) => {
    const next = { ...value }
    if (
      v === "" ||
      v === null ||
      v === undefined ||
      (Array.isArray(v) && v.length === 0)
    ) {
      delete next[key]
    } else {
      next[key] = v
    }
    onChange(next)
  }

  const sections = groupCustomFields(defs)

  return (
    <div className="grid gap-4 border-t border-border pt-4">
      {sections.map((section) => (
        <div key={section.key} className="grid gap-4">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {section.title}
          </div>
          {section.fields.map((d) => (
            <OneField
              key={d.id}
              def={d}
              value={value[d.key]}
              onChange={(v) => set(d.key, v)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function OneField({
  def: d,
  value,
  onChange,
}: {
  def: CustomField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = d.required ? `${d.label} *` : d.label
  const hint = d.description || undefined

  switch (d.type) {
    case "textarea":
      return (
        <FormTextarea
          label={label}
          hint={hint}
          value={asString(value)}
          onChange={onChange}
        />
      )
    case "boolean":
      return (
        <FormCheckbox
          label={label}
          hint={hint}
          checked={value === true}
          onChange={onChange}
        />
      )
    case "integer":
    case "decimal":
      return (
        <FormText
          label={label}
          hint={hint}
          type="number"
          value={asString(value)}
          onChange={onChange}
        />
      )
    case "url":
      return (
        <FormText
          label={label}
          hint={hint}
          type="url"
          value={asString(value)}
          onChange={onChange}
        />
      )
    case "date":
      return (
        <Field label={label} hint={hint}>
          <Input
            type="date"
            value={asString(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      )
    case "select":
      return (
        <FormSelect
          label={label}
          value={value == null || value === "" ? null : String(value)}
          onChange={(v) => onChange(v)}
          noneLabel="—"
          options={d.choices.map((c) => ({ value: c, label: c }))}
        />
      )
    case "object":
      return (
        <ObjectField
          def={d}
          label={label}
          hint={hint}
          value={value}
          onChange={onChange}
        />
      )
    case "multiselect": {
      const arr = Array.isArray(value) ? (value as string[]) : []
      return (
        <Field label={label} hint={hint}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {d.choices.map((c) => (
              <FormCheckbox
                key={c}
                label={c}
                checked={arr.includes(c)}
                onChange={(on) =>
                  onChange(on ? [...arr, c] : arr.filter((x) => x !== c))
                }
              />
            ))}
          </div>
        </Field>
      )
    }
    default:
      return (
        <FormText
          label={label}
          hint={hint}
          value={asString(value)}
          onChange={onChange}
        />
      )
  }
}

function ObjectField({
  def: d,
  label,
  hint,
  value,
  onChange,
}: {
  def: CustomField
  label: string
  hint?: string
  value: unknown
  onChange: (v: unknown) => void
}) {
  const meta = useCustomizationMeta()
  const refMeta = meta.data?.reference_models.find(
    (r) => r.value === d.related_model
  )
  if (!refMeta) {
    // Registry entry gone (plugin removed) — fall back to the raw id.
    return (
      <FormText
        label={label}
        hint={hint ?? `${d.related_model} id`}
        value={asString(value)}
        onChange={onChange}
      />
    )
  }
  return (
    <CfObjectPicker
      refMeta={refMeta}
      label={label}
      hint={hint}
      value={value == null || value === "" ? null : String(value)}
      onChange={(v) => onChange(v)}
      customFieldId={d.id}
    />
  )
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return ""
  return String(v)
}
