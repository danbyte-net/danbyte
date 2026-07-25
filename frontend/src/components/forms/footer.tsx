import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface FormFooterProps {
  onCancel: () => void
  submitting?: boolean
  submitLabel?: string
  /** What the button says while the request is in flight. Defaults to the
   * submit label's verb in continuous form ("Create" → "Creating…"), because
   * this used to hard-code "Saving…" for all 64 call sites — so a "Create"
   * button announced "Saving…". CLAUDE.md requires the verb track the action. */
  submittingLabel?: string
  cancelLabel?: string
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
  className,
}: FormFooterProps) {
  return (
    // flex-col-reverse on mobile matches DialogFooter, so buttons stack the
    // same way whichever footer a dialog happens to use.
    <div
      className={cn(
        "mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end",
        className
      )}
    >
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
