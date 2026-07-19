import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export interface FormCheckboxProps {
  label: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
  className?: string
}

// Inline checkbox + label. Different shape from the rest of the field
// primitives because the label sits next to the control, not above it.
export function FormCheckbox({
  label,
  checked,
  onChange,
  hint,
  className,
}: FormCheckboxProps) {
  return (
    <label
      className={cn("flex cursor-pointer items-start gap-2 text-xs", className)}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(!!v)}
        className="mt-0.5"
      />
      <span className="flex flex-col">
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </span>
    </label>
  )
}
