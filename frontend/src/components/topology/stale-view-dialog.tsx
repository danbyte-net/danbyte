import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * A Save refused with 409: somebody saved this view after it was opened
 * here, and writing over it would silently drop their work. The user keeps
 * theirs as a new view, or takes the newer one and drops their own edits.
 * Closing the dialog keeps editing; the next Save is refused the same way.
 */
export function StaleViewDialog({
  open,
  name,
  canCopy,
  reloading,
  onOpenChange,
  onSaveCopy,
  onReload,
}: {
  open: boolean
  name: string
  /** May create views (`topologyview.add`). */
  canCopy: boolean
  reloading: boolean
  onOpenChange: (open: boolean) => void
  onSaveCopy: () => void
  onReload: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Changed by someone else</DialogTitle>
          <DialogDescription>
            “{name}” was saved again after you opened it. Reload drops your
            changes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onReload} disabled={reloading}>
            {reloading ? "Reloading…" : "Reload"}
          </Button>
          {canCopy && (
            <Button onClick={onSaveCopy} disabled={reloading}>
              Save as copy
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
