import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ComplianceViolation } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

import { CONFIG_DRIFT_RULE_ID, invalidateCompliance } from "./compliance-shared"

type TriageAction = "acknowledge" | "snooze" | "clear"

const DAY = 24 * 60 * 60 * 1000
const PRESETS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
]

/** The local midnight starting `iso` (YYYY-MM-DD) - "snooze until the 3rd". */
export function startOfDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d)
}

/** `YYYY-MM-DD` of the local day `d` falls on. */
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The floating bar over ticked violations: acknowledge, snooze until a time,
 * or clear back to open. Config drift is the IaC runner's to clear, so its
 * rows are left out of the request.
 */
export function TriageBar({
  selected,
  onDone,
}: {
  selected: ComplianceViolation[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [note, setNote] = useState("")
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [date, setDate] = useState("")
  const items = selected
    .filter((v) => v.rule_id !== CONFIG_DRIFT_RULE_ID)
    .map((v) => ({ rule_id: v.rule_id, object_id: v.object_id }))
  const anyTriaged = selected.some((v) => v.state && v.state !== "open")

  const m = useMutation({
    mutationFn: (body: { action: TriageAction; until?: string }) =>
      api<{ updated: number }>("/api/compliance/triage/", {
        method: "POST",
        body: JSON.stringify({ ...body, items, note: note.trim() }),
      }),
    onSuccess: (d, body) => {
      const verb =
        body.action === "acknowledge"
          ? "Acknowledged"
          : body.action === "snooze"
            ? "Snoozed"
            : "Cleared"
      toast.success(
        `${verb} ${d.updated} violation${d.updated === 1 ? "" : "s"}`
      )
      setSnoozeOpen(false)
      setNote("")
      invalidateCompliance(qc)
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (selected.length === 0) return null
  const pending = m.isPending
  const run = (action: TriageAction, until?: Date) =>
    m.mutate({ action, until: until?.toISOString() })
  const today = localIsoDate(new Date())

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
        <span className="pl-2 text-xs font-medium whitespace-nowrap text-foreground">
          {selected.length} selected
        </span>
        <span className="h-4 w-px bg-border" />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note…"
          aria-label="Note"
          maxLength={255}
          className="h-7 w-36 text-xs sm:w-48"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={pending || items.length === 0}
          onClick={() => run("acknowledge")}
        >
          {pending && m.variables.action === "acknowledge"
            ? "Acknowledging…"
            : "Acknowledge"}
        </Button>
        <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={pending || items.length === 0}
            >
              {pending && m.variables.action === "snooze"
                ? "Snoozing…"
                : "Snooze until…"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 space-y-3" align="center">
            <div className="flex gap-1">
              {PRESETS.map((p) => (
                <Button
                  key={p.days}
                  size="sm"
                  variant="outline"
                  className="h-7 flex-1 px-2"
                  disabled={pending}
                  onClick={() =>
                    run("snooze", new Date(Date.now() + p.days * DAY))
                  }
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <DatePicker
                value={date}
                onChange={setDate}
                min={today}
                className="flex-1"
              />
              <Button
                size="sm"
                className="h-8"
                disabled={pending || !date || date <= today}
                onClick={() => run("snooze", startOfDay(date))}
              >
                Snooze
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {anyTriaged && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={pending || items.length === 0}
            onClick={() => run("clear")}
          >
            {pending && m.variables.action === "clear"
              ? "Reopening…"
              : "Reopen"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={onDone}
          aria-label="Clear selection"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
