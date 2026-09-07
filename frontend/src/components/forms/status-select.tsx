import { ColorBadge } from "@/components/cells/color-badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { Field } from "./field"

const NONE = "__none__"

/** Status picker that shows the status the way it actually renders: the
 * selected value is the real ColorBadge pill, and each option carries its
 * color dot. Works for anything shaped like a Status row. */
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
  const selected = options.find((s) => s.id === value)
  return (
    <Field label={label} hint={hint} error={error}>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger className="w-full">
          {selected ? (
            <ColorBadge
              name={selected.name}
              color={selected.color || undefined}
            />
          ) : (
            <SelectValue placeholder={placeholder} />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {options.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <ColorBadge name={s.name} color={s.color || undefined} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
