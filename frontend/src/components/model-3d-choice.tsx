import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Model3DFit, Model3DFront, Model3DUp } from "@/lib/api"
import type { ModelUnit } from "@/lib/model-3d-formats"

/** The 3D model settings' choices, as the card and the upload dialog
 * show them. */
export const FIT_CHOICES: { value: Model3DFit; label: string }[] = [
  { value: "auto", label: "Fit to size" },
  { value: "native", label: "Own size" },
]
export const UP_CHOICES: { value: Model3DUp; label: string }[] = [
  { value: "y", label: "Y up" },
  { value: "z", label: "Z up" },
]
export const FRONT_CHOICES: { value: Model3DFront; label: string }[] = [
  { value: "+z", label: "+Z" },
  { value: "-z", label: "−Z" },
  { value: "+x", label: "+X" },
  { value: "-x", label: "−X" },
]
export const UNIT_CHOICES: { value: ModelUnit; label: string }[] = [
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "m", label: "m" },
  { value: "in", label: "in" },
]

export function ChoiceSelect<T extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
}: {
  label: string
  value: T
  choices: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as T)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} size="sm" className="h-7 w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
