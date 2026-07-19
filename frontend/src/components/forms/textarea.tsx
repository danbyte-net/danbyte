import { Textarea } from "@/components/ui/textarea"
import { Field, type FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormTextareaProps extends Base {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}

export function FormTextarea({
  value,
  onChange,
  placeholder,
  rows = 2,
  ...field
}: FormTextareaProps) {
  return (
    <Field {...field}>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
      />
    </Field>
  )
}
