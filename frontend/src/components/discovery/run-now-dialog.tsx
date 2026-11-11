import { useEffect, useState } from "react"

import { FormCheckbox } from "@/components/forms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/ui/info-tip"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Run now (#451): confirm, with the per-run opt-in to accept new host keys
// on first use. Unticked every time it opens - never remembered, never a
// profile default; scheduled runs never use it.

export function RunNowDialog({
  open,
  onOpenChange,
  profileName,
  firstUseAllowed,
  canAcceptKeys,
  pending,
  onRun,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  profileName: string
  /** The deployment allows first-use keys at all; false hides the option. */
  firstUseAllowed: boolean
  /** The person may accept SSH host keys. */
  canAcceptKeys: boolean
  pending: boolean
  onRun: (acceptNewHostKeys: boolean) => void
}) {
  const [accept, setAccept] = useState(false)
  useEffect(() => {
    if (open) setAccept(false)
  }, [open])

  const box = (
    <FormCheckbox
      label="Accept new host keys"
      checked={accept}
      onChange={setAccept}
      disabled={!canAcceptKeys}
    />
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run {profileName} now?</DialogTitle>
        </DialogHeader>
        {firstUseAllowed && (
          <div className="space-y-1.5">
            {canAcceptKeys ? (
              box
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled control swallows the pointer; the span
                      carries the tooltip. */}
                  <span className="inline-flex">{box}</span>
                </TooltipTrigger>
                <TooltipContent variant="panel">
                  Needs change on SSH host keys.
                </TooltipContent>
              </Tooltip>
            )}
            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              Not advised: a host's key is trusted the first time it is seen.
              <InfoTip>
                For a host with no accepted key, the key it presents on this run
                is accepted and the login goes ahead on that same connection. If
                something sits between Danbyte and the host on that first
                contact, it is trusted instead. Prefer checking fingerprints
                under Host keys. A host whose key differs from an accepted one
                is still refused.
              </InfoTip>
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={pending} onClick={() => onRun(accept)}>
            {pending ? "Running…" : "Run now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
