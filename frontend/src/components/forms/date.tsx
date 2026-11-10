import type { FieldProps } from "./field"

import { DatePicker } from "@/components/ui/date-picker"
import { Field } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormDateProps extends Base {
  /** ISO `YYYY-MM-DD`, "" = empty. */
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  /** Earliest pickable day, ISO `YYYY-MM-DD`. */
  min?: string
  /** Latest pickable day, ISO `YYYY-MM-DD`. */
  max?: string
}

// Date field using the shared DatePicker (displays per the user's date-format
// setting) - the drop-in replacement for FormText type="date".
export function FormDate({
  value,
  onChange,
  placeholder,
  disabled,
  min,
  max,
  ...field
}: FormDateProps) {
  return (
    <Field {...field}>
      <DatePicker
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        min={min}
        max={max}
      />
    </Field>
  )
}
