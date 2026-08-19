import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, STORAGE_UNITS } from "@/lib/api"
import type { DcimChoices, Paginated, StorageUnit, TagOption } from "@/lib/api"
import { useCustomizationMeta } from "@/lib/custom-fields"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { CfObjectPicker } from "@/components/cf-object-picker"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SuggestInput } from "@/components/ui/suggest-input"
import { Field } from "./field"
import { FormCombobox } from "./combobox"
import { FormSelect } from "./select"
import type { SelectOption } from "./select"
import type { BulkFieldSpec } from "./field-spec"

// The one per-kind field editor. It renders a single BulkFieldSpec, in either
// of two modes:
//
//   mode="keep"   - bulk edit across N rows: an unset field means "keep what
//                   each row already has", so every control carries a KEEP
//                   sentinel (selects) or an arming checkbox (inputs).
//   mode="always" - a single-object form: the control is simply live.
//
// Option lists are hoisted into useFieldEditorOptions so the hooks stay
// unconditional and every consumer shares one react-query cache.

const KEEP = "__keep__"
const NONE = "__none__"

const yesNo = (v: unknown) => (v ? "yes" : "no")

export interface FieldEditorOptions {
  /** `/api/dcim/choices/` lists, for `kind: "choice"`. */
  dcimChoices: DcimChoices
  vlans: SelectOption[]
  vrfs: SelectOption[]
  statuses: SelectOption[]
  /** Tag picker options - fetched only when `opts.tags` is set. */
  tags: TagOption[]
}

/** Hoists every option query the given specs need, so hooks stay
 *  unconditional and both consumers share one react-query cache. */
export function useFieldEditorOptions(
  specs: BulkFieldSpec[],
  opts?: { tags?: boolean }
): FieldEditorOptions {
  const dcimChoices = useDcimChoices()

  const tagOptions = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    enabled: !!opts?.tags,
    staleTime: 10 * 60_000,
  })
  const vlanOptions = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; vlan_id: number; name: string }>>(
        "/api/vlans/?picker=1"
      ),
    enabled: specs.some((f) => f.kind === "vlan"),
    staleTime: 5 * 60_000,
  })
  const vrfOptions = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/vrfs/?picker=1"),
    enabled: specs.some((f) => f.kind === "vrf"),
    staleTime: 5 * 60_000,
  })
  const statusModel = specs.find(
    (f): f is Extract<BulkFieldSpec, { kind: "status" }> => f.kind === "status"
  )?.statusModel
  const statusOptions = useQuery({
    queryKey: ["statuses", statusModel],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        `/api/statuses/?available_to=${statusModel}&picker=1`
      ),
    enabled: !!statusModel,
    staleTime: 5 * 60_000,
  })

  return {
    dcimChoices,
    vlans: (vlanOptions.data?.results ?? []).map((v) => ({
      value: v.id,
      label: `${v.vlan_id} · ${v.name}`,
    })),
    vrfs: (vrfOptions.data?.results ?? []).map((v) => ({
      value: v.id,
      label: v.name,
    })),
    statuses: (statusOptions.data?.results ?? []).map((s) => ({
      value: s.id,
      label: s.name,
    })),
    tags: tagOptions.data?.results ?? [],
  }
}

export interface FieldEditorProps {
  spec: BulkFieldSpec
  /** `undefined` = not set. `null` = explicitly cleared. */
  value: unknown
  onChange: (v: unknown) => void
  /** "keep": KEEP sentinel + arming checkbox, for bulk edit across N rows
   *  (today's behaviour). "always": the field is always armed - single-object
   *  forms. */
  mode?: "keep" | "always"
  onClear?: () => void
  options: FieldEditorOptions
  disabled?: boolean
}

export function FieldEditor({
  spec: f,
  value,
  onChange,
  mode = "keep",
  onClear,
  options,
  disabled,
}: FieldEditorProps) {
  // Byte fields are entered as value + unit; the unit rides beside the value.
  const [byteUnit, setByteUnit] = useState<StorageUnit>("GB")

  const keep = mode === "keep"
  // In keep mode an untouched field is left alone; in always mode it is live.
  const active = keep ? value !== undefined : true
  const off = !active || !!disabled
  const unset = () => onClear?.()

  // Shared select plumbing. Note FormSelect maps its own "__none__"/"__keep__"
  // item values back to null before calling onChange, so the `v === null` arm
  // is the one that actually fires for both sentinels.
  const keepRow = keep ? [{ value: KEEP, label: "Keep current" }] : []
  const selectValue = active ? ((value as string | null) ?? NONE) : KEEP
  const onSelect = (v: string | null) =>
    keep
      ? v === KEEP || v === null
        ? unset()
        : onChange(v === NONE ? null : v)
      : onChange(v === NONE || v === null ? null : v)

  if (f.kind === "bool") {
    return (
      <FormSelect
        label={f.label}
        disabled={disabled}
        value={
          keep
            ? active
              ? yesNo(value)
              : KEEP
            : value == null
              ? null
              : yesNo(value)
        }
        onChange={(v) =>
          v === KEEP || v === null
            ? keep
              ? unset()
              : onChange(null)
            : onChange(v === "yes")
        }
        options={[
          ...keepRow,
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ]}
      />
    )
  }
  if (f.kind === "choice") {
    // Searchable + optgroup-aware: the type lists run to hundreds of
    // entries, and they carry their own `group`.
    return (
      <FormCombobox
        label={f.label}
        hint={f.hint}
        disabled={disabled}
        value={selectValue}
        onChange={onSelect}
        options={[
          ...keepRow,
          { value: NONE, label: `Clear ${f.label.toLowerCase()}` },
          // `?? []`: a backend older than this build omits newer
          // lists entirely, and spreading undefined would throw.
          ...(options.dcimChoices[f.choices] ?? []),
        ]}
        searchPlaceholder={`Search ${f.label.toLowerCase()}…`}
        emptyText="No matches."
      />
    )
  }
  if (f.kind === "options" || f.kind === "status") {
    const opts = f.kind === "options" ? f.options : options.statuses
    return (
      <FormSelect
        label={f.label}
        hint={f.hint}
        disabled={disabled}
        value={selectValue}
        onChange={onSelect}
        options={[
          ...keepRow,
          ...(f.kind === "status"
            ? [{ value: NONE, label: "Clear status" }]
            : []),
          ...opts,
        ]}
      />
    )
  }
  if (f.kind === "bytes") {
    // Deliberately not UnitInput: that primitive stores a *string* in a fixed
    // base unit and keeps the stored amount when the unit changes, while this
    // control stores a number of bytes, re-interprets the shown number in the
    // new unit, and needs the arming checkbox + "Keep current" placeholder.
    // Different unit set (KB…PB vs MEMORY_UNITS/DISK_UNITS) too.
    const factor =
      STORAGE_UNITS.find((u) => u.value === byteUnit)?.factor ?? 1e9
    const raw = value
    return (
      <Field label={f.label} hint={f.hint}>
        <div className="flex items-center gap-2">
          {keep && (
            <Checkbox
              checked={active}
              disabled={disabled}
              onCheckedChange={(v) => (v ? onChange(null) : unset())}
              title={active ? "Will be set" : "Keep current"}
            />
          )}
          <Input
            type="number"
            value={
              active && typeof raw === "number"
                ? String(Number((raw / factor).toFixed(3)))
                : ""
            }
            onChange={(e) =>
              onChange(
                e.target.value === ""
                  ? null
                  : Math.round(Number(e.target.value) * factor)
              )
            }
            placeholder={active ? "" : "Keep current"}
            disabled={off}
          />
          <Select
            value={byteUnit}
            disabled={off}
            onValueChange={(v) => {
              const next = v as StorageUnit
              // Re-interpret the shown number in the new unit.
              const shown = typeof raw === "number" ? raw / factor : null
              setByteUnit(next)
              if (shown != null) {
                const nf =
                  STORAGE_UNITS.find((u) => u.value === next)?.factor ?? 1e9
                onChange(Math.round(shown * nf))
              }
            }}
          >
            <SelectTrigger className="w-[88px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STORAGE_UNITS.map((u) => (
                <SelectItem key={u.value} value={u.value}>
                  {u.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Field>
    )
  }
  if (f.kind === "vlan" || f.kind === "vrf") {
    const opts = f.kind === "vlan" ? options.vlans : options.vrfs
    return (
      <FormSelect
        label={f.label}
        disabled={disabled}
        value={selectValue}
        onChange={onSelect}
        options={[
          ...keepRow,
          { value: NONE, label: `Clear ${f.label.toLowerCase()}` },
          ...opts,
        ]}
      />
    )
  }
  if (f.kind === "object") {
    // `disabled` is dropped here: CfObjectPicker takes no disabled flag.
    return <ObjectFieldEditor spec={f} value={value} onChange={onChange} />
  }
  // text / int: a checkbox arms the field, the input carries it.
  return (
    <Field label={f.label} hint={f.hint}>
      <div className="flex items-center gap-2">
        {keep && (
          <Checkbox
            checked={active}
            disabled={disabled}
            onCheckedChange={(v) =>
              v ? onChange(f.kind === "int" ? null : "") : unset()
            }
            title={active ? "Will be set" : "Keep current"}
          />
        )}
        {f.suggestions && f.suggestions.length > 0 ? (
          <SuggestInput
            value={active && value !== null ? String(value ?? "") : ""}
            onChange={(v) => onChange(v)}
            suggestions={f.suggestions}
            placeholder={active ? "" : "Keep current"}
            disabled={off}
          />
        ) : (
          <Input
            type={f.kind === "int" ? "number" : "text"}
            value={active && value !== null ? String(value ?? "") : ""}
            onChange={(e) =>
              onChange(
                f.kind === "int"
                  ? e.target.value === ""
                    ? null
                    : Number(e.target.value)
                  : e.target.value
              )
            }
            placeholder={active ? "" : "Keep current"}
            disabled={off}
          />
        )}
      </div>
    </Field>
  )
}

/**
 * A reference-registry object, rendered with the same picker custom fields use.
 * Split out so the customization-meta query only runs for specs that need it.
 *
 * No KEEP sentinel here: the picker's own "-" row clears to null, and nothing
 * declares `kind: "object"` in a bulk-edit dialog today, so keep mode is a
 * pass-through - an untouched picker stays out of `values` either way.
 */
function ObjectFieldEditor({
  spec,
  value,
  onChange,
}: {
  spec: Extract<BulkFieldSpec, { kind: "object" }>
  value: unknown
  onChange: (v: unknown) => void
}) {
  const meta = useCustomizationMeta()
  const refMeta = meta.data?.reference_models.find(
    (r) => r.value === spec.object_model
  )
  if (!refMeta) {
    return (
      <Field label={spec.label} hint={spec.hint}>
        <p className="text-[12px] text-muted-foreground">
          {meta.isPending
            ? "Loading..."
            : `Unknown object type "${spec.object_model}"`}
        </p>
      </Field>
    )
  }
  return (
    <CfObjectPicker
      refMeta={refMeta}
      label={spec.label}
      hint={spec.hint}
      value={typeof value === "string" && value !== "" ? value : null}
      onChange={(v) => onChange(v)}
    />
  )
}
