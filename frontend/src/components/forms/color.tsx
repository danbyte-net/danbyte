import { ColorPicker } from "@/components/ui/color-picker"
import { Field, type FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormColorProps extends Base {
  value: string
  onChange: (v: string) => void
  allowEmpty?: boolean
}

export function FormColor({
  value,
  onChange,
  allowEmpty = true,
  ...field
}: FormColorProps) {
  return (
    <Field {...field}>
      <ColorPicker value={value} onChange={onChange} allowEmpty={allowEmpty} />
    </Field>
  )
}
