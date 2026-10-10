import { Combobox } from "@/components/ui/combobox"

import { Field } from "./field"

/** Status picker that shows the status the way it actually renders: the
 * selected value and every option are the real ColorBadge pill. Searchable,
 * like every other object field (#276). Works for anything shaped like a
 * Status row. */
export function FormStatusSelect({
  label = "Status",
  hint,
  value,
  onChange,
  options,
  noneLabel = "No status",
  placeholder = "Pick status",
  error,
}: {
  label?: string
  hint?: string
  value: string | null
  onChange: (id: string | null) => void
  options: { id: string; name: string; color?: string | null }[]
  noneLabel?: string
  placeholder?: string
  error?: string
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      <Combobox
        value={value}
        onChange={onChange}
        options={options.map((s) => ({
          value: s.id,
          label: s.name,
          color: s.color,
          badge: true,
        }))}
        noneLabel={noneLabel}
        placeholder={placeholder}
        searchPlaceholder="Search statuses…"
        emptyText="No statuses."
      />
    </Field>
  )
}
