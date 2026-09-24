import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { HolidayCalendar, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormText, FormTextarea, useFieldErrors } from "@/components/forms"
import { ConfirmDialog } from "@/components/confirm-dialog"

const URL = "/api/monitoring/holiday-calendars/"

/** Holiday calendars, shared by every agreement that picks one: a bank
 * holiday is entered once. Opened from the SLAs list. */
export function HolidayCalendarsButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarDays className="h-3.5 w-3.5" /> Holidays
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Holiday calendars</DialogTitle>
          </DialogHeader>
          {open && <Calendars />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Calendars() {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["holiday-calendars"],
    queryFn: () => api<Paginated<HolidayCalendar>>(`${URL}?page_size=200`),
  })
  const [editing, setEditing] = useState<HolidayCalendar | "new" | null>(null)
  const [deleting, setDeleting] = useState<HolidayCalendar | null>(null)
  const del = useMutation({
    mutationFn: (c: HolidayCalendar) =>
      api<void>(`${URL}${c.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Calendar deleted")
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ["holiday-calendars"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  if (editing)
    return (
      <CalendarForm
        calendar={editing === "new" ? undefined : editing}
        onDone={() => setEditing(null)}
      />
    )
  const rows = q.data?.results ?? []
  return (
    <div className="space-y-3">
      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No holiday calendars yet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 px-3 py-2 text-[13px]"
            >
              <button
                type="button"
                className="link font-medium"
                onClick={() => setEditing(c)}
              >
                {c.name}
              </button>
              <span className="text-muted-foreground">
                {c.dates.length} day{c.dates.length === 1 ? "" : "s"} ·{" "}
                {c.agreement_count} agreement
                {c.agreement_count === 1 ? "" : "s"}
              </span>
              {canDo("holidaycalendar", "delete") && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setDeleting(c)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canDo("holidaycalendar", "add") && (
        <Button size="sm" onClick={() => setEditing("new")}>
          New calendar
        </Button>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Agreements that use it measure those days again."
        confirmLabel="Delete"
        pendingLabel="Deleting..."
        destructive
        pending={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  )
}

function CalendarForm({
  calendar,
  onDone,
}: {
  calendar?: HolidayCalendar
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(calendar?.name ?? "")
  const [dates, setDates] = useState((calendar?.dates ?? []).join("\n"))
  const save = useMutation({
    mutationFn: () => {
      reset()
      const body = JSON.stringify({
        name: name.trim(),
        dates: dates
          .split(/[\s,]+/)
          .map((d) => d.trim())
          .filter(Boolean),
      })
      return calendar
        ? api(`${URL}${calendar.id}/`, { method: "PATCH", body })
        : api(URL, { method: "POST", body })
    },
    onSuccess: () => {
      toast.success(calendar ? "Calendar saved" : "Calendar created")
      qc.invalidateQueries({ queryKey: ["holiday-calendars"] })
      onDone()
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FormText
        label="Name"
        value={name}
        onChange={setName}
        required
        placeholder="Denmark"
        error={fieldErrors.name}
      />
      <FormTextarea
        label="Dates"
        value={dates}
        onChange={setDates}
        rows={8}
        placeholder={"2026-12-24\n2026-12-25"}
        info="One date per line, YYYY-MM-DD."
        error={fieldErrors.dates}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save"}
        </Button>
      </div>
    </form>
  )
}
