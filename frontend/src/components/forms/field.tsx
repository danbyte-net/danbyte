import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

// Shared field wrapper. Renders label + optional hint + the field
// children + an optional error line. Every typed form field component
// in this folder composes this.
export interface FieldProps {
  label: string
  hint?: string
  error?: string
  className?: string
  children: React.ReactNode
}

export function Field({ label, hint, error, className, children }: FieldProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
