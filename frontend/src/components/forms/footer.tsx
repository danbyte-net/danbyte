import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface FormFooterProps {
  onCancel: () => void
  submitting?: boolean
  submitLabel?: string
  cancelLabel?: string
  className?: string
}

// Cancel + Submit pair. Drop into any form dialog.
export function FormFooter({
  onCancel,
  submitting,
  submitLabel = "Save changes",
  cancelLabel = "Cancel",
  className,
}: FormFooterProps) {
  return (
    <div className={cn("mt-2 flex items-center justify-end gap-2", className)}>
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        disabled={submitting}
      >
        {cancelLabel}
      </Button>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : submitLabel}
      </Button>
    </div>
  )
}
