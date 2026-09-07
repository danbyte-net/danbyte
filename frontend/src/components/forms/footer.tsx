import type { ReactNode } from "react"
import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { usePlanTarget } from "@/lib/save-object"

export interface FormFooterProps {
  onCancel: () => void
  submitting?: boolean
  submitLabel?: string
  /** What the button says while the request is in flight. Defaults to the
   * submit label's verb in continuous form ("Create" → "Creating…"), because
   * this used to hard-code "Saving…" for all 64 call sites - so a "Create"
   * button announced "Saving…". CLAUDE.md requires the verb track the action. */
  submittingLabel?: string
  cancelLabel?: string
  /** Extra action pinned to the left of the bar, e.g. "Create & add another".
   * It belongs inside the footer: on a full-page form the footer becomes a
   * sticky bar with its own background, which would otherwise cover a sibling
   * button sitting next to it. */
  secondary?: ReactNode
  className?: string
}

/** "Create" → "Creating…", "Save changes" → "Saving…", "Apply" → "Applying…".
 * Handles the drop-e ("Create" → "Creating", not "Createing") and falls back to
 * the label unchanged when it isn't a simple verb phrase. */
function pendingLabel(label: string): string {
  const [verb, ...rest] = label.trim().split(/\s+/)
  if (!verb) return "Saving…"
  const lower = verb.toLowerCase()
  const stem =
    lower.endsWith("e") && !lower.endsWith("ee") ? verb.slice(0, -1) : verb
  // Keep only the verb: "Save changes" → "Saving…", not "Saving changes…".
  void rest
  return `${stem}ing…`
}

// Cancel + Submit pair. Drop into any form dialog.
export function FormFooter({
  onCancel,
  submitting,
  submitLabel = "Save changes",
  submittingLabel,
  cancelLabel = "Cancel",
  secondary,
  className,
}: FormFooterProps) {
  // In plan mode this button does not write, so it must not say "Save". Done
  // here rather than in each form: every form's footer is this component.
  const planning = !!usePlanTarget()
  // Cmd/Ctrl+Enter submits the enclosing form - every form has this footer,
  // so every form gets the shortcut. Listening on the form itself scopes it:
  // with a dialog form stacked over a page form, only the focused one fires.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const form = rootRef.current?.closest("form")
    if (!form) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        form.requestSubmit()
      }
    }
    form.addEventListener("keydown", onKey)
    return () => form.removeEventListener("keydown", onKey)
  }, [])
  if (planning) {
    submitLabel = "Save as planned change"
    submittingLabel = "Planning…"
  }
  return (
    // flex-col-reverse on mobile matches DialogFooter, so buttons stack the
    // same way whichever footer a dialog happens to use.
    <div
      // `data-form-footer` lets EditPageShell make this a sticky action bar on
      // full-page forms (see the `.edit-page-form [data-form-footer]` rule in
      // styles.css) so Save stays reachable without scrolling to the bottom.
      // Dialogs use the same forms but aren't inside .edit-page-form, so their
      // footers are unaffected.
      ref={rootRef}
      data-form-footer=""
      className={cn(
        "mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end",
        className
      )}
    >
      {secondary && <div className="sm:mr-auto">{secondary}</div>}
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        disabled={submitting}
      >
        {cancelLabel}
      </Button>
      <Button type="submit" disabled={submitting}>
        {submitting
          ? (submittingLabel ?? pendingLabel(submitLabel))
          : submitLabel}
      </Button>
    </div>
  )
}
