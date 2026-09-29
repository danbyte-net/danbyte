import { useState } from "react"

import { FormText } from "@/components/forms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { REASON_MAX } from "./reset-availability-dialog"

/**
 * Confirm excluding an address from monitoring, with an optional reason for
 * the note, the change log and the journal. Including it again needs no
 * confirmation - it only turns checking back on.
 */
export function ExcludeMonitoringDialog({
  open,
  onOpenChange,
  pending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  error?: string
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  const close = (next: boolean) => {
    if (!next) setReason("")
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!pending) onConfirm(reason.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>Exclude from monitoring</DialogTitle>
            <DialogDescription>
              Its checks stop, open alerts close, and the time off doesn&apos;t
              count toward availability.
            </DialogDescription>
          </DialogHeader>
          <FormText
            label="Reason"
            hint="optional"
            value={reason}
            onChange={(v) => setReason(v.slice(0, REASON_MAX))}
            placeholder="Host decommissioned"
            error={error}
            autoFocus
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => close(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Excluding…" : "Exclude"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
