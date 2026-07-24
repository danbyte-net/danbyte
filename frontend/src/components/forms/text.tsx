import { Input } from "@/components/ui/input"
import { SuggestInput } from "@/components/ui/suggest-input"
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
  /** Common values, offered in a dropdown. The field stays free text. */
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
  const shared = {
    type,
    value,
    placeholder,
    required,
    autoFocus,
    autoComplete,
    inputMode,
    min,
    max,
    className: cn(mono && "font-mono", inputClassName),
  }
  return (
    <Field {...field}>
      {suggestions && suggestions.length > 0 ? (
        <SuggestInput
          {...shared}
          onChange={onChange}
          suggestions={suggestions}
        />
      ) : (
        <Input {...shared} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  )
}
