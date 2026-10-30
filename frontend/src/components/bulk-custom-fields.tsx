import type { CustomField } from "@/lib/api"
import { useCustomizationMeta } from "@/lib/custom-fields"
import type { ReferenceModelMeta } from "@/lib/custom-fields"
import { asArray } from "@/lib/utils"
import { useCustomFieldDefs } from "@/components/custom-field-display"
import {
  CheckList,
  Field,
  FieldEditor,
  useFieldEditorOptions,
} from "@/components/forms"
import type { BulkFieldSpec } from "@/components/forms"
import { Checkbox } from "@/components/ui/checkbox"
import { DatePicker } from "@/components/ui/date-picker"

// A bulk edit's custom fields: each one Keep or Set on its own, the way the
// dialog's other fields work. `values` holds only the armed keys; a null or
// empty value clears the field on every selected row.

/** A custom field as the shared field editor's spec, or null for the types
 * it has no editor for (dates and multi-selects get their own row). */
export function customFieldSpec(
  d: CustomField,
  refs: ReferenceModelMeta[]
): BulkFieldSpec | null {
  const base = { key: d.key, label: d.label, hint: d.description || undefined }
  switch (d.type) {
    case "integer":
      return { ...base, kind: "int" }
    case "boolean":
      return { ...base, kind: "bool" }
    case "select":
      return {
        ...base,
        kind: "options",
        options: asArray(d.choices).map((c) => ({ value: c, label: c })),
      }
    case "object": {
      const ref = refs.find((r) => r.value === d.related_model)
      return {
        ...base,
        kind: "object",
        object_model: d.related_model,
        ...(ref?.picker ? { endpoint: ref.endpoint } : {}),
      }
    }
    case "date":
    case "multiselect":
      return null
    default:
      // text, textarea, url, decimal: the server coerces the typed value.
      return { ...base, kind: "text" }
  }
}

export function BulkCustomFields({
  model,
  values,
  onChange,
}: {
  /** Custom-field model slug, e.g. "virtualmachine". */
  model: string
  values: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const defs = useCustomFieldDefs(model).data?.results ?? []
  const refs = useCustomizationMeta().data?.reference_models ?? []
  const specs = defs.map((d) => [d, customFieldSpec(d, refs)] as const)
  const options = useFieldEditorOptions(
    specs.flatMap(([, s]) => (s ? [s] : []))
  )
  if (defs.length === 0) return null

  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v })
  const unset = (key: string) => {
    const next = { ...values }
    delete next[key]
    onChange(next)
  }

  return (
    <>
      <p className="pt-1 text-[12px] font-medium text-muted-foreground">
        Custom fields
      </p>
      {specs.map(([d, spec]) =>
        spec ? (
          <FieldEditor
            key={d.key}
            spec={spec}
            mode="keep"
            value={values[d.key]}
            onChange={(v) => set(d.key, v)}
            onClear={() => unset(d.key)}
            options={options}
          />
        ) : (
          <ArmedField
            key={d.key}
            def={d}
            value={values[d.key]}
            onChange={(v) => set(d.key, v)}
            onClear={() => unset(d.key)}
          />
        )
      )}
    </>
  )
}

/** A date or multi-select custom field: the checkbox arms it, as the text
 * fields of the shared editor do. */
function ArmedField({
  def: d,
  value,
  onChange,
  onClear,
}: {
  def: CustomField
  value: unknown
  onChange: (v: unknown) => void
  onClear: () => void
}) {
  const active = value !== undefined
  return (
    <Field label={d.label} hint={d.description || undefined}>
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-2"
          checked={active}
          onCheckedChange={(on) =>
            on ? onChange(d.type === "multiselect" ? [] : null) : onClear()
          }
          aria-label={active ? "Will be set" : "Keep current"}
        />
        <div className="min-w-0 flex-1">
          {d.type === "multiselect" ? (
            active ? (
              <CheckList
                options={asArray(d.choices).map((c) => ({
                  value: c,
                  label: c,
                }))}
                value={Array.isArray(value) ? (value as string[]) : []}
                onChange={onChange}
              />
            ) : (
              <p className="pt-2 text-[12px] text-muted-foreground">
                Keep current
              </p>
            )
          ) : (
            <DatePicker
              value={typeof value === "string" ? value : ""}
              onChange={onChange}
              placeholder={active ? "Pick a date" : "Keep current"}
              disabled={!active}
            />
          )}
        </div>
      </div>
    </Field>
  )
}
