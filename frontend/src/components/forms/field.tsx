import { type ReactNode } from "react"

import { Label } from "@/components/ui/label"
import { InfoTip } from "@/components/ui/info-tip"
import { PendingFieldMark } from "@/lib/pending-fields"
import { cn } from "@/lib/utils"

// Shared field wrapper. Renders label + optional hint + the field
// children + an optional error line. Every typed form field component
// in this folder composes this.
export interface FieldProps {
  label: string
  hint?: string
  /** Optional explanation shown via an (i) info-icon popover beside the label.
   * Prefer this over cramming a clarification into the label in parentheses. */
  info?: ReactNode
  error?: string
  /** Mark the label. Field components forward their own `required` here — until
   * this existed, 111 `required` props across 82 files rendered NOTHING, so the
   * only signal a user got was the browser's native validation bubble on
   * submit. That absence is why so many fields say `hint="optional"`: the
   * codebase was signalling the inverse because the direct signal was dead. */
  required?: boolean
  className?: string
  children: React.ReactNode
}

export function Field({
  label,
  hint,
  info,
  error,
  required,
  className,
  children,
}: FieldProps) {
  return (
    // content-start: when a grid stretches this cell to match a taller
    // neighbour (e.g. a checkbox stack), pack label+input at the top instead
    // of distributing the leftover height between them (the "floating input
    // far below its label" bug).
    <div className={cn("grid content-start gap-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <Label className="flex items-center gap-1 text-xs">
          {label}
          {required && (
            // Not `text-destructive`: an untouched required field isn't an
            // error, and colouring it red on load reads as one.
            <span aria-hidden className="ml-0.5 text-muted-foreground">
              *
            </span>
          )}
          {info && <InfoTip>{info}</InfoTip>}
          {/* "A change to this value is already planned" — renders
              nothing unless a PendingFieldsProvider says so. */}
          <PendingFieldMark label={label} />
        </Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
