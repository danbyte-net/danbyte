import { IconPicker } from "@/components/icon-picker"

import { Field } from "./field"
import type { FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormIconProps extends Base {
  value: string
  onChange: (v: string) => void
  allowEmpty?: boolean
}

export function FormIcon({
  value,
  onChange,
  allowEmpty = true,
  ...field
}: FormIconProps) {
  return (
    <Field {...field}>
      <IconPicker value={value} onChange={onChange} allowEmpty={allowEmpty} />
    </Field>
  )
}
