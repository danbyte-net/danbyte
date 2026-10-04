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

const COPY = {
  exclude: {
    title: "Exclude from monitoring",
    body: "Its checks stop, open alerts close, and the time off doesn't count toward availability.",
    placeholder: "Host decommissioned",
    verb: "Exclude",
    pending: "Excluding…",
  },
  include: {
    title: "Include in monitoring",
    body: "Its checks run again from now.",
    placeholder: "Host back in service",
    verb: "Include",
    pending: "Including…",
  },
} as const

/**
 * Confirm excluding an address from monitoring, or including it again, with
 * an optional reason for the change log and the journal (an exclusion's
 * reason is on the tab's note too).
 */
export function ExcludeMonitoringDialog({
  open,
  onOpenChange,
  mode = "exclude",
  pending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: "exclude" | "include"
  pending: boolean
  error?: string
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  const copy = COPY[mode]
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
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.body}</DialogDescription>
          </DialogHeader>
          <FormText
            label="Reason"
            hint="optional"
            value={reason}
            onChange={(v) => setReason(v.slice(0, REASON_MAX))}
            placeholder={copy.placeholder}
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
              {pending ? copy.pending : copy.verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
