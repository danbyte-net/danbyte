import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export interface FormCheckboxProps {
  label: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
  disabled?: boolean
  className?: string
}

// Inline checkbox + label. Different shape from the rest of the field
// primitives because the label sits next to the control, not above it.
export function FormCheckbox({
  label,
  checked,
  onChange,
  hint,
  disabled,
  className,
}: FormCheckboxProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 text-xs",
        // Dim the whole row, not just the box - the label has to read as
        // unavailable too.
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(!!v)}
        disabled={disabled}
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
