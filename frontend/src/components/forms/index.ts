// Reusable form-field primitives. Every form dialog imports from this
// single barrel:
//
//   import {
//     FormText, FormTextarea, FormSelect, FormColor, FormTags,
//     FormCheckbox, FormRow, FormFooter, useFieldErrors,
//   } from "@/components/forms"

export { Field } from "./field"
export type { FieldProps } from "./field"
export { FormText } from "./text"
export type { FormTextProps } from "./text"
export { FormDate } from "./date"
export type { FormDateProps } from "./date"
export { FormTextarea } from "./textarea"
export type { FormTextareaProps } from "./textarea"
export { FormSelect } from "./select"
export type { FormSelectProps, SelectOption } from "./select"
export { FormCombobox } from "./combobox"
export type { FormComboboxProps } from "./combobox"
export { QuickAddDialog } from "./quick-add"
export type { QuickAddField } from "./quick-add"
export { UnitInput, MEMORY_UNITS, DISK_UNITS } from "./unit-input"
export type { Unit } from "./unit-input"
export { FormColor } from "./color"
export type { FormColorProps } from "./color"
export { FormIcon } from "./icon"
export type { FormIconProps } from "./icon"
export { FormTags } from "./tags"
export type { FormTagsProps } from "./tags"
export { FormCheckbox } from "./checkbox"
export type { FormCheckboxProps } from "./checkbox"
export { FormRow } from "./row"
export type { FormRowProps } from "./row"
export { FormFooter } from "./footer"
export type { FormFooterProps } from "./footer"
export { useFieldErrors } from "./use-field-errors"

export { CheckList } from "./check-list"
export type { CheckOption } from "./check-list"
