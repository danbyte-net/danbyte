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

/** What `useBlocker({ withResolver: true })` hands back, as far as the
 *  dialog needs it: blocked or not, and the two ways to settle it. */
export type LeaveBlocker = {
  status: "blocked" | "idle"
  proceed?: () => void
  reset?: () => void
}

/**
 * The one unsaved-changes dialog for an editor that holds edits until Save
 * (a floor plan, a topology view). Open while the router's blocker is
 * blocked. The router holds the navigation until this settles, so every close
 * path settles it: Escape, an overlay click and "Keep editing" all mean stay
 * (reset); "Discard and leave" lets the navigation through (proceed). Leave
 * the blocker hanging and every later navigation is stuck behind it.
 */
export function LeaveGuardDialog({
  blocker,
  description = "This map has unsaved changes.",
}: {
  blocker: LeaveBlocker
  description?: string
}) {
  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          {/* Radix closes on action too, so onOpenChange's reset() lands
              right after this proceed(). Both settle the same promise and
              only the first wins, so the navigation still goes through. */}
          <AlertDialogAction
            variant="destructive"
            onClick={() => blocker.proceed?.()}
          >
            Discard and leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
