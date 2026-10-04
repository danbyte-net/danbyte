import type { Dispatch, SetStateAction } from "react"

import type { CabinetSizes } from "@/lib/api"
import { FormText } from "@/components/forms"

/** The five size inputs of a cabinet or cabinet type, held as text so a
 * blank field stays blank rather than turning into 0. */
export type CabinetSizeValues = Record<keyof CabinetSizes, string>

export const NO_SIZES: CabinetSizeValues = {
  inner_width_mm: "",
  inner_height_mm: "",
  outer_width_mm: "",
  outer_height_mm: "",
  outer_depth_mm: "",
}

/** The form values for a set of sizes (a type's, a cabinet's). */
export function sizeValues(s: CabinetSizes): CabinetSizeValues {
  const text = (v: number | null) => (v != null ? String(v) : "")
  return {
    inner_width_mm: text(s.inner_width_mm),
    inner_height_mm: text(s.inner_height_mm),
    outer_width_mm: text(s.outer_width_mm),
    outer_height_mm: text(s.outer_height_mm),
    outer_depth_mm: text(s.outer_depth_mm),
  }
}

/** A required size: left out of the payload when blank, so the server
 * answers for it (or copies it from a cabinet's type). */
export function mm(v: string): number | undefined {
  return v.trim() === "" ? undefined : Number(v)
}

/** An optional size: blank clears it. */
export function mmOrNull(v: string): number | null {
  return v.trim() === "" ? null : Number(v)
}

// Whole millimetres, as the API takes them: a plate or box side is 50-5000,
// a depth 20-3000.
const SIDE = { min: 50, max: 5000 }
const DEPTH = { min: 20, max: 3000 }

/** The mounting plate (required) and the box around it (optional), shared
 * by the cabinet and cabinet-type forms so both read the same. */
export function CabinetSizeFields({
  value,
  onChange,
  errors,
}: {
  value: CabinetSizeValues
  onChange: Dispatch<SetStateAction<CabinetSizeValues>>
  errors: Record<string, string | undefined>
}) {
  const set = (key: keyof CabinetSizes) => (v: string) =>
    onChange((cur) => ({ ...cur, [key]: v }))
  return (
    <div className="grid gap-3 @md:grid-cols-2">
      <FormText
        label="Plate width (mm)"
        required
        type="number"
        {...SIDE}
        value={value.inner_width_mm}
        onChange={set("inner_width_mm")}
        error={errors.inner_width_mm}
      />
      <FormText
        label="Plate height (mm)"
        required
        type="number"
        {...SIDE}
        value={value.inner_height_mm}
        onChange={set("inner_height_mm")}
        error={errors.inner_height_mm}
      />
      <FormText
        label="Outer width (mm)"
        hint="optional"
        type="number"
        {...SIDE}
        value={value.outer_width_mm}
        onChange={set("outer_width_mm")}
        error={errors.outer_width_mm}
      />
      <FormText
        label="Outer height (mm)"
        hint="optional"
        type="number"
        {...SIDE}
        value={value.outer_height_mm}
        onChange={set("outer_height_mm")}
        error={errors.outer_height_mm}
      />
      <FormText
        label="Outer depth (mm)"
        hint="optional"
        type="number"
        {...DEPTH}
        value={value.outer_depth_mm}
        onChange={set("outer_depth_mm")}
        error={errors.outer_depth_mm}
      />
    </div>
  )
}
