import { type ReactNode } from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TruncatedText } from "@/components/ui/truncated-text"
import { Field, type FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface SelectOption {
  value: string
  label: ReactNode
}

export interface FormSelectProps extends Base {
  value: string | null
  onChange: (v: string | null) => void
  options: SelectOption[]
  /** When true, prepends a "(keep)" sentinel - used in bulk-edit dialogs. */
  allowKeep?: boolean
  /** When set, prepends a NULL sentinel with this label (e.g. "Global"). */
  noneLabel?: string
  placeholder?: string
  disabled?: boolean
}

/** Tooltip text for an option whose label is a node (a coloured badge, say) -
 * the string it was built from, when we can see one. */
function labelText(label: ReactNode): string {
  return typeof label === "string" ? label : ""
}

// Internal sentinel - the Select primitive disallows the empty string as a
// SelectItem value; it maps back to null on change.
const NONE = "__none__"

/** The "(keep)" row's value. With `allowKeep`, initialise your state to this
 * and treat it as "don't change the field" when building the payload. `null`
 * then unambiguously means "clear to none" - previously both rows collapsed
 * to null, which made clearing a field in a bulk edit impossible (#218). */
export const KEEP_VALUE = "__keep__"

export function FormSelect({
  value,
  onChange,
  options,
  allowKeep,
  noneLabel,
  placeholder,
  disabled,
  ...field
}: FormSelectProps) {
  const stringValue = value === null || value === undefined ? NONE : value
  const selected = options.find((o) => o.value === stringValue)

  return (
    <Field {...field}>
      <Select
        value={stringValue}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          {/* Radix renders the chosen item's own node; wrapping it keeps a
              long label inside its field instead of pushing into the next
              one, and hands the full text back on hover (#124). */}
          <SelectValue placeholder={placeholder}>
            {selected !== undefined ? (
              <TruncatedText title={labelText(selected.label)}>
                {selected.label}
              </TruncatedText>
            ) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {allowKeep && <SelectItem value={KEEP_VALUE}>(keep)</SelectItem>}
          {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
