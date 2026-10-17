import { useId, useMemo } from "react"
import type { ReactNode } from "react"

import { FieldControlContext } from "@/components/ui/field-control"
import type { FieldControl } from "@/components/ui/field-control"
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
  /** Mark the label. Field components forward their own `required` here - until
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
  // The hint slot beside the label is sized for a word like "optional". A
  // sentence there squeezes the label into a sliver and wraps into a ragged
  // tower - which is what every long hint in this codebase was doing. Long ones
  // drop below the control instead, where they have the full width.
  const hintBelow = (hint?.length ?? 0) > 40

  // The label names its control (#428): `htmlFor` gives click-to-focus, and
  // the control reads the same id (plus hint/error descriptions) from context
  // so no form has to wire it by hand.
  const id = useId()
  const labelId = `${id}-label`
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined
  const control = useMemo<FieldControl>(
    () => ({ id, labelId, describedBy, invalid: !!error }),
    [id, labelId, describedBy, error]
  )

  return (
    // content-start: when a grid stretches this cell to match a taller
    // neighbour (e.g. a checkbox stack), pack label+input at the top instead
    // of distributing the leftover height between them (the "floating input
    // far below its label" bug).
    // min-w-0: grid/flex items default to min-width:auto, so a long option
    // label in a picker trigger widened the whole column and shoved the
    // neighbouring field aside (#53). Allowing the cell to shrink lets the
    // trigger's own `truncate` finally do its job.
    <div
      data-field-error={error ? "" : undefined}
      className={cn("grid min-w-0 content-start gap-1.5", className)}
    >
      {/* The label never wraps: it is the thing the eye reads first, and a
          "Next" / "hop" tower beside a hint is unreadable. When the two do not
          fit on one line in a narrow column, the hint - not the label - drops
          onto the next line (flex-wrap), still above the control. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        {/* The (i) and planned-change marks sit beside the <label>, not in
            it: inside, their buttons would be read out as part of the
            field's name. */}
        <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
          <Label
            id={labelId}
            htmlFor={id}
            className="gap-1 text-xs whitespace-nowrap"
          >
            {label}
            {required && (
              // Not `text-destructive`: an untouched required field isn't an
              // error, and colouring it red on load reads as one.
              <span aria-hidden className="ml-0.5 font-semibold text-primary">
                *
              </span>
            )}
          </Label>
          {info && <InfoTip>{info}</InfoTip>}
          {/* "A change to this value is already planned" - renders
              nothing unless a PendingFieldsProvider says so. */}
          <PendingFieldMark label={label} />
        </span>
        {hint && !hintBelow && (
          <span
            id={hintId}
            className="ml-auto min-w-0 text-[10px] text-muted-foreground"
          >
            {hint}
          </span>
        )}
      </div>
      <FieldControlContext.Provider value={control}>
        {children}
      </FieldControlContext.Provider>
      {hint && hintBelow && (
        <p
          id={hintId}
          className="text-[10px] leading-snug text-muted-foreground"
        >
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
