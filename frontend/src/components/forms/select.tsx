import { type ReactNode } from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  /** When true, prepends a "(keep)" sentinel — used in bulk-edit dialogs. */
  allowKeep?: boolean
  /** When set, prepends a NULL sentinel with this label (e.g. "Global"). */
  noneLabel?: string
  placeholder?: string
  disabled?: boolean
}

// Internal sentinels — the Select primitive disallows the empty string
// as a SelectItem value. We map both back to their real meanings on
// change.
const NONE = "__none__"
const KEEP = "__keep__"

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
  const stringValue =
    value === null || value === undefined ? (allowKeep ? KEEP : NONE) : value

  return (
    <Field {...field}>
      <Select
        value={stringValue}
        onValueChange={(v) => onChange(v === NONE || v === KEEP ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowKeep && <SelectItem value={KEEP}>(keep)</SelectItem>}
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
