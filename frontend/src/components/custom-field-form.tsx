import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type CustomField,
  type CustomFieldGroup,
  type CustomFieldScopeRules,
  type CustomFieldType,
  type CustomFieldWritePayload,
  type Paginated,
} from "@/lib/api"
import {
  CHOICE_TYPES,
  CUSTOMIZABLE_MODELS,
  CUSTOM_FIELD_TYPES,
  useCustomizationMeta,
} from "@/lib/custom-fields"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

// Sentinel thrown to abort the mutation on client-side validation failure so
// onError can skip the generic toast (the field error is already surfaced).
const CLIENT_INVALID = "client-validation"

export interface CustomFieldFormProps {
  field?: CustomField
  onSaved: (saved: CustomField) => void
  onCancel: () => void
}

export function CustomFieldForm({
  field,
  onSaved,
  onCancel,
}: CustomFieldFormProps) {
  const isEdit = !!field
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [key, setKey] = useState(field?.key ?? "")
  const [label, setLabel] = useState(field?.label ?? "")
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text")
  const [appliesTo, setAppliesTo] = useState<string[]>(field?.applies_to ?? [])
  const [choicesText, setChoicesText] = useState(
    (field?.choices ?? []).join("\n")
  )
  const [required, setRequired] = useState(field?.required ?? false)
  const [defVal, setDefVal] = useState(field?.default ?? "")
  const [description, setDescription] = useState(field?.description ?? "")
  const [weight, setWeight] = useState(field ? String(field.weight) : "0")
  const [weightError, setWeightError] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(field?.group ?? null)
  const [relatedModel, setRelatedModel] = useState<string | null>(
    field?.related_model || null
  )
  const [scopeRules, setScopeRules] = useState<CustomFieldScopeRules>(
    field?.scope_rules ?? {}
  )
  // Registry-served lists: applies_to auto-derives from CustomFieldsMixin
  // (plugins included); reference models drive the object-type target.
  const meta = useCustomizationMeta()
  const modelOptions = meta.data?.models ?? CUSTOMIZABLE_MODELS

  const groupsQuery = useQuery({
    queryKey: ["custom-field-groups", "picker"],
    queryFn: () =>
      api<Paginated<CustomFieldGroup>>("/api/custom-field-groups/"),
    staleTime: 5 * 60_000,
  })
  const groupOptions = (groupsQuery.data?.results ?? []).map((g) => ({
    value: g.id,
    label: g.name,
  }))

  useEffect(() => {
    if (!field) return
    setKey(field.key)
    setLabel(field.label)
    setType(field.type)
    setAppliesTo(field.applies_to)
    setChoicesText(field.choices.join("\n"))
    setRequired(field.required)
    setDefVal(field.default)
    setDescription(field.description)
    setWeight(String(field.weight))
    setWeightError(null)
    setGroup(field.group ?? null)
    setRelatedModel(field.related_model || null)
    setScopeRules(field.scope_rules ?? {})
    reset()
  }, [field, reset])

  const needsChoices = CHOICE_TYPES.includes(type)

  const toggleModel = (m: string) =>
    setAppliesTo((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    )

  const mutation = useMutation({
    mutationFn: async () => {
      // Number("abc") is NaN, which would serialize as null and silently
      // clobber the weight — validate before building the payload.
      const trimmedWeight = weight.trim()
      const weightNum = trimmedWeight === "" ? 0 : Number(trimmedWeight)
      if (!Number.isFinite(weightNum)) {
        setWeightError("Weight must be a number.")
        throw new Error(CLIENT_INVALID)
      }
      setWeightError(null)
      const payload: CustomFieldWritePayload = {
        related_model: type === "object" ? (relatedModel ?? "") : "",
        key: key.trim(),
        label: label.trim(),
        type,
        applies_to: appliesTo,
        choices: needsChoices
          ? choicesText
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        required,
        default: defVal.trim(),
        description: description.trim(),
        weight: weightNum,
        group,
        scope_rules: scopeRules,
      }
      if (isEdit)
        return api<CustomField>(`/api/custom-fields/${field!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<CustomField>("/api/custom-fields/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["custom-fields"] })
      qc.invalidateQueries({ queryKey: ["custom-field", saved.id] })
      toast.success(
        isEdit ? `Updated ${saved.label}` : `Created ${saved.label}`
      )
      onSaved(saved)
    },
    onError: (err) => {
      if ((err as Error).message === CLIENT_INVALID) return
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormText
        label="Key"
        required
        mono
        autoFocus={!isEdit}
        value={key}
        onChange={setKey}
        hint="The JSON key, e.g. owner_team"
        placeholder="owner_team"
        error={fieldErrors.key}
      />
      <FormText
        label="Label"
        required
        value={label}
        onChange={setLabel}
        placeholder="Owner team"
        error={fieldErrors.label}
      />
      <FormSelect
        label="Type"
        value={type}
        onChange={(v) => v && setType(v as CustomFieldType)}
        options={CUSTOM_FIELD_TYPES.map((t) => ({
          value: t.value,
          label: t.label,
        }))}
        error={fieldErrors.type}
      />

      {type === "object" && (
        <FormSelect
          label="Referenced model"
          value={relatedModel}
          onChange={setRelatedModel}
          placeholder="Pick a model"
          options={(meta.data?.reference_models ?? []).map((r) => ({
            value: r.value,
            label: r.label,
          }))}
          hint="The field's value is one object of this model, picked with the advanced search."
          error={fieldErrors.related_model}
        />
      )}

      {needsChoices && (
        <FormTextarea
          label="Choices"
          hint="One per line"
          value={choicesText}
          onChange={setChoicesText}
          rows={4}
          placeholder={"production\nstaging\ndev"}
          error={fieldErrors.choices}
        />
      )}

      <Field
        label="Applies to"
        hint="Which objects can carry this field"
        error={fieldErrors.applies_to}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {modelOptions.map((m) => (
            <FormCheckbox
              key={m.value}
              label={m.label}
              checked={appliesTo.includes(m.value)}
              onChange={() => toggleModel(m.value)}
            />
          ))}
        </div>
      </Field>

      <ScopeRulesEditor value={scopeRules} onChange={setScopeRules} />

      <FormText
        label="Default value"
        value={defVal}
        onChange={setDefVal}
        hint="Optional initial value (stored as text)"
        error={fieldErrors.default}
      />
      <FormCheckbox
        label="Required"
        hint="Must be filled in when shown on a form"
        checked={required}
        onChange={setRequired}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="What this field is for"
        error={fieldErrors.description}
      />
      <FormText
        label="Weight"
        type="number"
        value={weight}
        onChange={(v) => {
          setWeight(v)
          setWeightError(null)
        }}
        hint="Display order, low → high"
        error={weightError ?? fieldErrors.weight}
      />
      <FormSelect
        label="Group"
        value={group}
        onChange={setGroup}
        noneLabel="— None —"
        options={groupOptions}
        hint="Optional section heading this field shows under."
        error={fieldErrors.group}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create field"}
      />
    </form>
  )
}

function ScopeRulesEditor({
  value,
  onChange,
}: {
  value: CustomFieldScopeRules
  onChange: (next: CustomFieldScopeRules) => void
}) {
  const deviceTypes = useQuery({
    queryKey: ["device-types-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-types/?picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const deviceRoles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-roles/?picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<{ slug: string; name: string }>>("/api/tags/"),
    staleTime: 5 * 60_000,
  })

  const setRule = (
    key: keyof CustomFieldScopeRules,
    side: "include" | "exclude",
    values: string[]
  ) => {
    const next = { ...value }
    const cur = { ...(next[key] ?? {}) }
    cur[side] = values.filter(Boolean)
    if ((cur.include?.length ?? 0) === 0 && (cur.exclude?.length ?? 0) === 0) {
      delete next[key]
    } else {
      next[key] = cur
    }
    onChange(next)
  }
  const toggle = (
    key: keyof CustomFieldScopeRules,
    side: "include" | "exclude",
    id: string,
    checked: boolean
  ) => {
    const cur = value[key]?.[side] ?? []
    setRule(key, side, checked ? [...cur, id] : cur.filter((x) => x !== id))
  }
  const csv = (key: keyof CustomFieldScopeRules, side: "include" | "exclude") =>
    (value[key]?.[side] ?? []).join(", ")
  const setCsv = (
    key: keyof CustomFieldScopeRules,
    side: "include" | "exclude",
    raw: string
  ) =>
    setRule(
      key,
      side,
      raw.split(",").map((s) => s.trim())
    )

  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <div>
        <div className="text-xs font-medium">Visibility &amp; Scope</div>
        <div className="text-xs text-muted-foreground">
          Empty rules keep the field visible and object pickers unrestricted.
        </div>
      </div>
      <Field label="Device type whitelist / blacklist">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {(deviceTypes.data?.results ?? []).map((d) => (
            <div key={d.id} className="grid gap-1">
              <FormCheckbox
                label={`Show ${d.name}`}
                checked={(value.device_types?.include ?? []).includes(d.id)}
                onChange={(on) => toggle("device_types", "include", d.id, on)}
              />
              <FormCheckbox
                label={`Hide ${d.name}`}
                checked={(value.device_types?.exclude ?? []).includes(d.id)}
                onChange={(on) => toggle("device_types", "exclude", d.id, on)}
              />
            </div>
          ))}
        </div>
      </Field>
      <Field label="Device role whitelist / blacklist">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {(deviceRoles.data?.results ?? []).map((d) => (
            <div key={d.id} className="grid gap-1">
              <FormCheckbox
                label={`Show ${d.name}`}
                checked={(value.device_roles?.include ?? []).includes(d.id)}
                onChange={(on) => toggle("device_roles", "include", d.id, on)}
              />
              <FormCheckbox
                label={`Hide ${d.name}`}
                checked={(value.device_roles?.exclude ?? []).includes(d.id)}
                onChange={(on) => toggle("device_roles", "exclude", d.id, on)}
              />
            </div>
          ))}
        </div>
      </Field>
      <Field label="Tag whitelist / blacklist">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {(tags.data?.results ?? []).map((t) => (
            <div key={t.slug} className="grid gap-1">
              <FormCheckbox
                label={`Show ${t.name}`}
                checked={(value.tags?.include ?? []).includes(t.slug)}
                onChange={(on) => toggle("tags", "include", t.slug, on)}
              />
              <FormCheckbox
                label={`Hide ${t.name}`}
                checked={(value.tags?.exclude ?? []).includes(t.slug)}
                onChange={(on) => toggle("tags", "exclude", t.slug, on)}
              />
            </div>
          ))}
        </div>
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <FormText
          label="VLAN ranges allowed"
          value={csv("vlan_ranges", "include")}
          onChange={(v) => setCsv("vlan_ranges", "include", v)}
          placeholder="100-199, 300"
        />
        <FormText
          label="VLAN ranges blocked"
          value={csv("vlan_ranges", "exclude")}
          onChange={(v) => setCsv("vlan_ranges", "exclude", v)}
          placeholder="50, 900-999"
        />
        <FormText
          label="IP/prefix ranges allowed"
          value={csv("ip_ranges", "include")}
          onChange={(v) => setCsv("ip_ranges", "include", v)}
          placeholder="10.0.0.0/8, 2001:db8::/32"
        />
        <FormText
          label="IP/prefix ranges blocked"
          value={csv("ip_ranges", "exclude")}
          onChange={(v) => setCsv("ip_ranges", "exclude", v)}
          placeholder="10.0.9.0/24"
        />
        <FormText
          label="Name contains"
          value={csv("name_patterns", "include")}
          onChange={(v) => setCsv("name_patterns", "include", v)}
          placeholder="core, edge"
        />
        <FormText
          label="Name excludes"
          value={csv("name_patterns", "exclude")}
          onChange={(v) => setCsv("name_patterns", "exclude", v)}
          placeholder="test, retired"
        />
      </div>
    </div>
  )
}
