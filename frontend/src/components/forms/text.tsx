import { useId } from "react"

import { Input } from "@/components/ui/input"
import { Field, type FieldProps } from "./field"
import { cn } from "@/lib/utils"

type Base = Omit<FieldProps, "children">

export interface FormTextProps extends Base {
  value: string
  onChange: (v: string) => void
  type?: "text" | "number" | "email" | "url" | "tel" | "password" | "date"
  placeholder?: string
  required?: boolean
  autoFocus?: boolean
  autoComplete?: string
  mono?: boolean
  inputClassName?: string
  inputMode?:
    | "text"
    | "numeric"
    | "decimal"
    | "email"
    | "tel"
    | "url"
    | "search"
  min?: number
  max?: number
  /** Free-text suggestions — rendered as a <datalist> dropdown. */
  suggestions?: string[]
}

export function FormText({
  value,
  onChange,
  type = "text",
  placeholder,
  required,
  autoFocus,
  autoComplete,
  mono,
  inputClassName,
  inputMode,
  min,
  max,
  suggestions,
  ...field
}: FormTextProps) {
  const listId = useId()
  return (
    <Field {...field}>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        inputMode={inputMode}
        min={min}
        max={max}
        list={suggestions && suggestions.length ? listId : undefined}
        className={cn(mono && "font-mono", inputClassName)}
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </Field>
  )
}
