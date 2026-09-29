import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { HolidayCalendar, Paginated, SlaAgreement } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { HolidayCalendarEditor } from "./holiday-calendar-editor"
import { calendarSummary } from "./holiday-days"

const URL = "/api/monitoring/holiday-calendars/"
/** Agreement links shown per calendar before "+N". */
const SHOWN_AGREEMENTS = 3

/** Holiday calendars, shared by every agreement that picks one: a bank
 * holiday is entered once. Opened from the SLAs list. */
export function HolidayCalendarsButton() {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  // Which calendar the editor has open: one, or a new one.
  const [editing, setEditing] = useState<{ calendar?: HolidayCalendar } | null>(
    null
  )
  if (!canDo("holidaycalendar", "view")) return null
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarDays className="h-3.5 w-3.5" /> Holidays
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Holiday calendars</DialogTitle>
            <DialogDescription>
              Agreements that use a calendar do not measure its days.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <Calendars
              onEdit={(calendar) => setEditing({ calendar })}
              onNew={() => setEditing({})}
              onLeave={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      {/* A sibling, not a child: the list keeps its width behind the wide
          editor, and is there again when the editor closes. */}
      {editing && (
        <HolidayCalendarEditor
          key={editing.calendar?.id ?? "new"}
          calendar={editing.calendar}
          readOnly={!!editing.calendar && !canDo("holidaycalendar", "change")}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

function Calendars({
  onEdit,
  onNew,
  onLeave,
}: {
  onEdit: (c: HolidayCalendar) => void
  onNew: () => void
  onLeave: () => void
}) {
  const { canDo } = useMe()
  const { today } = useDateFormat()
  const year = Number(today.slice(0, 4))
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["holiday-calendars"],
    queryFn: () => api<Paginated<HolidayCalendar>>(`${URL}?page_size=200`),
  })
  // The SLAs list's own query, so this is usually a cache hit - and already
  // limited to the agreements this user may see.
  const agreements = useQuery({
    queryKey: ["sla-agreements", ""],
    queryFn: () =>
      api<Paginated<SlaAgreement>>(
        "/api/monitoring/sla-agreements/?page_size=200"
      ),
    enabled: canDo("slaagreement", "view"),
  })
  const byCalendar = useMemo(() => {
    const out = new Map<string, SlaAgreement[]>()
    for (const a of agreements.data?.results ?? []) {
      if (!a.holiday_calendar) continue
      out.set(a.holiday_calendar, [...(out.get(a.holiday_calendar) ?? []), a])
    }
    return out
  }, [agreements.data])
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

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="grid gap-3">
      {rows.length === 0 ? (
        <EmptyState title="No holiday calendars yet.">
          A calendar holds the days agreements do not measure.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((c) => {
            const used = byCalendar.get(c.id) ?? []
            const more =
              c.agreement_count - Math.min(used.length, SHOWN_AGREEMENTS)
            return (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="link text-[13px] font-medium"
                    onClick={() => onEdit(c)}
                  >
                    {c.name}
                  </button>
                  <div className="num text-xs text-muted-foreground">
                    {calendarSummary(c.dates, c.agreement_count, year)}
                  </div>
                  {used.length > 0 && (
                    <div className="flex flex-wrap gap-x-2 text-xs">
                      {used.slice(0, SHOWN_AGREEMENTS).map((a) => (
                        <Link
                          key={a.id}
                          to="/monitoring/sla/$id"
                          params={{ id: a.id }}
                          className="link"
                          onClick={onLeave}
                        >
                          {a.name}
                        </Link>
                      ))}
                      {more > 0 && (
                        <span className="num text-muted-foreground">
                          +{more}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {canDo("holidaycalendar", "delete") && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => setDeleting(c)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent variant="default">Delete</TooltipContent>
                  </Tooltip>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canDo("holidaycalendar", "add") && (
        <div>
          <Button size="sm" onClick={onNew}>
            <Plus className="h-3.5 w-3.5" /> New calendar
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Agreements that use it measure those days again."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        pending={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  )
}
