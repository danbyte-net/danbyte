import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { Field, type FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormComboboxProps extends Base {
  value: string | null
  onChange: (v: string | null) => void
  options: ComboboxOption[]
  /** When set, offers a clear-to-null row with this label (e.g. "No device"). */
  noneLabel?: string
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  /** Optional trailing control — e.g. a <QuickAddDialog/> "+" button to create
   * the related object inline. Rendered to the right of the combobox. */
  quickAdd?: React.ReactNode
}

// Searchable drop-in for FormSelect — same Field wrapper + value/onChange
// contract, but type-to-filter. Use it wherever the option list is long.
export function FormCombobox({
  value,
  onChange,
  options,
  noneLabel,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  quickAdd,
  ...field
}: FormComboboxProps) {
  const combobox = (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      noneLabel={noneLabel}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      disabled={disabled}
    />
  )
  return (
    <Field {...field}>
      {quickAdd ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{combobox}</div>
          {quickAdd}
        </div>
      ) : (
        combobox
      )}
    </Field>
  )
}
