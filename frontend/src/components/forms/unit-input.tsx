import { useState } from "react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field } from "./field"

export interface Unit {
  /** Symbol shown in the dropdown, e.g. "GiB". */
  label: string
  /** How many *base* units one of this unit equals. Base unit has factor 1. */
  factor: number
}

/** Memory is stored in MB. Decimal (MB/GB/TB) + binary (MiB/GiB/TiB) factors. */
export const MEMORY_UNITS: Unit[] = [
  { label: "MB", factor: 1 },
  { label: "MiB", factor: 1.048576 },
  { label: "GB", factor: 1000 },
  { label: "GiB", factor: 1073.741824 },
  { label: "TB", factor: 1_000_000 },
  { label: "TiB", factor: 1_099_511.627776 },
]

/** Disk is stored in GB. */
export const DISK_UNITS: Unit[] = [
  { label: "GB", factor: 1 },
  { label: "GiB", factor: 1.073741824 },
  { label: "TB", factor: 1000 },
  { label: "TiB", factor: 1073.741824 },
]

/**
 * Number input with a trailing unit selector. The value passed in/out is always
 * in the **base** unit (the field's stored unit, factor 1); typing in a
 * different unit converts to base on the way out, and switching units just
 * re-displays the same stored amount. Empty input → "".
 */
export function UnitInput({
  label,
  base,
  units,
  value,
  onChange,
  error,
  placeholder,
}: {
  label: string
  /** Base/stored unit symbol — must be one of `units` (e.g. "MB"). */
  base: string
  units: Unit[]
  /** Value in base units, as a string ("" when empty). */
  value: string
  onChange: (baseValue: string) => void
  error?: string
  placeholder?: string
}) {
  const [unit, setUnit] = useState(base)
  const factor = units.find((u) => u.label === unit)?.factor ?? 1
  const display = value === "" ? "" : trim(Number(value) / factor)

  const typed = (disp: string) => {
    if (disp.trim() === "") return onChange("")
    const n = Number(disp)
    if (Number.isNaN(n)) return
    onChange(String(Math.round(n * factor)))
  }

  return (
    <Field label={label} error={error}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          value={display}
          onChange={(e) => typed(e.target.value)}
          placeholder={placeholder ?? "—"}
          className="min-w-0 flex-1"
        />
        <Select value={unit} onValueChange={setUnit}>
          <SelectTrigger className="h-9 w-20 shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {units.map((u) => (
              <SelectItem key={u.label} value={u.label}>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Field>
  )
}

/** Up to 2 decimals, no trailing zeros, as a string for the input. */
function trim(n: number): string {
  return String(Math.round(n * 100) / 100)
}
