import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { IpMonitoringInfo } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Field, FormText, useFieldErrors } from "@/components/forms"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

/** The reason column's length - the server refuses anything longer. */
export const REASON_MAX = 200

export type ResetMode = "reset" | "clear"

/** The request body: nothing for "from now", a day for "from a date",
 * `clear` to count everything again - and always the reason. */
export function resetPayload({
  mode,
  from,
  day,
  reason,
}: {
  mode: ResetMode
  from: "now" | "date"
  day: string
  reason: string
}): { reason: string; since?: string; clear?: true } {
  const body: { reason: string; since?: string; clear?: true } = {
    reason: reason.trim().slice(0, REASON_MAX),
  }
  if (mode === "clear") body.clear = true
  else if (from === "date" && day) body.since = day
  return body
}

/** Whether the dialog may submit: a reason, and a day when one is asked for. */
export function canSubmitReset(
  mode: ResetMode,
  from: "now" | "date",
  day: string,
  reason: string
): boolean {
  if (!reason.trim()) return false
  return mode === "clear" || from === "now" || !!day
}

/** The day an ISO instant falls on in `timeZone`, as `YYYY-MM-DD`. */
function dayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))
}

/**
 * Reset an address's availability - uptime, SLA and availability count from
 * now or from a day - or clear the reset. A reason is required either way:
 * it goes on the address's note, its change log and journal, and on the
 * journal of every agreement it changes.
 */
export function ResetAvailabilityDialog({
  open,
  onOpenChange,
  ipId,
  mode,
  info,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ipId: string
  mode: ResetMode
  info?: IpMonitoringInfo
  onDone: () => void
}) {
  const { today, settings } = useDateFormat()
  const [from, setFrom] = useState<"now" | "date">("now")
  const [day, setDay] = useState("")
  const [reason, setReason] = useState("")
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const close = (next: boolean) => {
    if (!next) {
      setFrom("now")
      setDay("")
      setReason("")
      reset()
    }
    onOpenChange(next)
  }

  const save = useMutation({
    mutationFn: () =>
      api<{ monitoring: IpMonitoringInfo }>(
        `/api/monitoring/ips/${ipId}/reset-availability/`,
        {
          method: "POST",
          body: JSON.stringify(resetPayload({ mode, from, day, reason })),
        }
      ),
    onSuccess: () => {
      toast.success(
        mode === "clear" ? "Availability reset cleared" : "Availability reset"
      )
      onDone()
      close(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const earliest = info?.created_at
    ? dayIn(info.created_at, settings.timezone)
    : undefined
  const ready = canSubmitReset(mode, from, day, reason)

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          // The reason, not the first radio: it is the one thing to type.
          const input = (
            e.currentTarget as HTMLElement
          ).querySelector<HTMLInputElement>('input[type="text"]')
          if (input) {
            e.preventDefault()
            input.focus()
          }
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && !save.isPending) save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {mode === "clear"
                ? "Clear availability reset"
                : "Reset availability"}
            </DialogTitle>
            <DialogDescription>
              {mode === "clear"
                ? "All history counts again."
                : "Uptime, SLA and availability count from then. Earlier history is kept but not counted."}
            </DialogDescription>
          </DialogHeader>
          {mode === "reset" && (
            <Field label="Counts from" error={fieldErrors.since}>
              <RadioGroup
                value={from}
                onValueChange={(v) => setFrom(v as "now" | "date")}
              >
                <Label className="flex items-center gap-2 text-[13px] font-normal">
                  <RadioGroupItem value="now" />
                  Now
                </Label>
                <div className="flex items-center gap-2">
                  <Label className="flex items-center gap-2 text-[13px] font-normal whitespace-nowrap">
                    <RadioGroupItem value="date" />
                    From a date
                  </Label>
                  <DatePicker
                    value={day}
                    onChange={(v) => {
                      setDay(v)
                      if (v) setFrom("date")
                    }}
                    min={earliest}
                    max={today}
                    className="h-8 w-44"
                  />
                </div>
              </RadioGroup>
            </Field>
          )}
          <FormText
            label="Reason"
            required
            value={reason}
            onChange={(v) => setReason(v.slice(0, REASON_MAX))}
            placeholder="New host on the address"
            error={fieldErrors.reason}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => close(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || save.isPending}>
              {mode === "clear"
                ? save.isPending
                  ? "Clearing…"
                  : "Clear"
                : save.isPending
                  ? "Resetting…"
                  : "Reset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
