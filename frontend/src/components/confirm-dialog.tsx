import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PendingLabel } from "@/components/pending-label"
import type { BatchProgress } from "@/lib/bulk-batches"

/**
 * One confirmation for an action that cannot be taken back.
 *
 * The entity delete dialogs each carry this same forty lines; this is the
 * shape without the entity, for the places that need a yes/no and a verb:
 * deleting a rule, removing a host from another system, applying a batch that
 * includes one. `children` sits between the text and the buttons - the choices
 * a bulk action offers - and `confirmDisabled` holds the verb back until one
 * is made. The button keeps its size while `pending`; a run in batches passes
 * `batches` and its `progress` to show the batch on its way.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  pendingLabel = "Deleting…",
  destructive = true,
  pending = false,
  confirmDisabled = false,
  progress = null,
  batches = 1,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  pendingLabel?: string
  destructive?: boolean
  pending?: boolean
  confirmDisabled?: boolean
  progress?: BatchProgress | null
  batches?: number
  onConfirm: () => void
  children?: React.ReactNode
}) {
  return (
    <AlertDialog
      open={open}
      // Nor does Escape close it while it works: Cancel is disabled then.
      onOpenChange={(next) => {
        if (next || !pending) onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending || confirmDisabled}
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
          >
            <PendingLabel
              label={confirmLabel}
              verb={pendingLabel}
              pending={pending}
              progress={progress}
              batches={batches}
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
