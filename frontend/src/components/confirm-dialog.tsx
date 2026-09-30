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

/**
 * One confirmation for an action that cannot be taken back.
 *
 * The entity delete dialogs each carry this same forty lines; this is the
 * shape without the entity, for the places that need a yes/no and a verb:
 * deleting a rule, removing a host from another system, applying a batch that
 * includes one. `children` sits between the text and the buttons - the choices
 * a bulk action offers - and `confirmDisabled` holds the verb back until one
 * is made.
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
  onConfirm: () => void
  children?: React.ReactNode
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
            {pending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
