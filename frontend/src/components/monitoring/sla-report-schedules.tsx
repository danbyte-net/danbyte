import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Send, Trash2 } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, SlaReportSchedule } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  FormCheckbox,
  FormSelect,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  WEEKDAYS,
  slaReportScheduleColumns,
} from "@/components/columns/sla-schedule-columns"

const URL = "/api/monitoring/sla-report-schedules/"

/** Weekly or monthly emailed reports: one agreement's (`agreementId`), or
 * the overview of every agreement (`agreementId` null). Sent by the SLA
 * timer; a failed send is tried again on its next run. */
export function SlaReportSchedules({
  agreementId,
}: {
  agreementId: string | null
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const key = ["sla-report-schedules", agreementId ?? "overview"]
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<Paginated<SlaReportSchedule>>(
        `${URL}?${agreementId ? `agreement=${agreementId}` : "overview=1"}&page_size=100`
      ),
  })
  const [editing, setEditing] = useState<SlaReportSchedule | "new" | null>(null)
  const [deleting, setDeleting] = useState<SlaReportSchedule | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const del = useMutation({
    mutationFn: (s: SlaReportSchedule) =>
      api<void>(`${URL}${s.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Schedule deleted")
      setDeleting(null)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })
  const send = useMutation({
    mutationFn: (s: SlaReportSchedule) =>
      api(`${URL}${s.id}/send-now/`, { method: "POST" }),
    onSuccess: (_d, s) => {
      toast.success(`Report sent to ${s.recipients.join(", ")}`)
      refresh()
    },
    onError: (e) => {
      apiErrorToast(e)
      refresh()
    },
  })
  const canEdit = canDo("slaagreement", "change")
  const columns = useMemo<ColumnDef<SlaReportSchedule>[]>(() => {
    const cols = slaReportScheduleColumns()
    if (!canEdit) return cols
    return [
      ...cols,
      {
        id: "actions",
        enableSorting: false,
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Send now"
              disabled={send.isPending}
              onClick={() => send.mutate(row.original)}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Edit schedule"
              onClick={() => setEditing(row.original)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete schedule"
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ]
  }, [canEdit, send])
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" /> New schedule
          </Button>
        </div>
      )}
      {q.isError && <QueryError error={q.error} />}
      <DataTable
        columns={columns}
        data={q.data?.results ?? []}
        tableId={agreementId ? "sla-schedules" : "sla-overview-schedules"}
        exportName="sla-report-schedules"
        exportTitle="SLA report schedules"
        flexColumn="recipients"
      />
      <ScheduleDialog
        agreementId={agreementId}
        schedule={editing && editing !== "new" ? editing : undefined}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this schedule?"
        description="Reports already sent are not affected."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        pending={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  )
}

/** The overview report's schedules, opened from the SLAs list. */
export function SlaOverviewSchedulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Overview report schedules</DialogTitle>
          <DialogDescription>
            Every agreement's figure, emailed weekly or monthly.
          </DialogDescription>
        </DialogHeader>
        {open && <SlaReportSchedules agreementId={null} />}
      </DialogContent>
    </Dialog>
  )
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, "0")}:00`,
}))
const DAYS = Array.from({ length: 28 }, (_, d) => ({
  value: String(d + 1),
  label: String(d + 1),
}))

function ScheduleDialog({
  agreementId,
  schedule,
  open,
  onOpenChange,
  onSaved,
}: {
  agreementId: string | null
  schedule?: SlaReportSchedule
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {schedule ? "Edit schedule" : "New schedule"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <ScheduleForm
            agreementId={agreementId}
            schedule={schedule}
            onDone={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ScheduleForm({
  agreementId,
  schedule: s,
  onDone,
  onSaved,
}: {
  agreementId: string | null
  schedule?: SlaReportSchedule
  onDone: () => void
  onSaved: () => void
}) {
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [frequency, setFrequency] = useState(s?.frequency ?? "monthly")
  const [weekday, setWeekday] = useState(String(s?.weekday ?? 0))
  const [day, setDay] = useState(String(s?.day_of_month ?? 1))
  const [hour, setHour] = useState(String(s?.hour ?? 7))
  const [period, setPeriod] = useState(s?.period ?? "previous")
  const [recipients, setRecipients] = useState((s?.recipients ?? []).join("\n"))
  const [format, setFormat] = useState(s?.report_format ?? "pdf")
  const [enabled, setEnabled] = useState(s?.enabled ?? true)
  const save = useMutation({
    mutationFn: () => {
      reset()
      const body = JSON.stringify({
        ...(s ? {} : { agreement: agreementId }),
        frequency,
        weekday: Number(weekday),
        day_of_month: Number(day),
        hour: Number(hour),
        period,
        recipients: recipients
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        report_format: format,
        enabled,
      })
      return s
        ? api(`${URL}${s.id}/`, { method: "PATCH", body })
        : api(URL, { method: "POST", body })
    },
    onSuccess: () => {
      toast.success("Schedule saved")
      onSaved()
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
      <div className="grid gap-3 sm:grid-cols-3">
        <FormSelect
          label="Every"
          value={frequency}
          onChange={(v) => setFrequency(v as typeof frequency)}
          options={[
            { value: "weekly", label: "Week" },
            { value: "monthly", label: "Month" },
          ]}
        />
        {frequency === "weekly" ? (
          <FormSelect
            label="On"
            value={weekday}
            onChange={(v) => setWeekday(v ?? "0")}
            options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            error={fieldErrors.weekday}
          />
        ) : (
          <FormSelect
            label="Day"
            value={day}
            onChange={(v) => setDay(v ?? "1")}
            options={DAYS}
            error={fieldErrors.day_of_month}
          />
        )}
        <FormSelect
          label="At"
          value={hour}
          onChange={(v) => setHour(v ?? "7")}
          options={HOURS}
          info={
            agreementId
              ? "In the agreement's timezone."
              : "In the tenant's timezone."
          }
          error={fieldErrors.hour}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormSelect
          label="Report on"
          value={period}
          onChange={(v) => setPeriod(v as typeof period)}
          options={[
            { value: "previous", label: "Last period" },
            { value: "current", label: "This period" },
          ]}
          error={fieldErrors.period}
        />
        <FormSelect
          label="Report as"
          value={format}
          onChange={(v) => setFormat(v as typeof format)}
          options={[
            { value: "pdf", label: "PDF" },
            { value: "csv", label: "CSV" },
            { value: "both", label: "PDF and CSV" },
          ]}
        />
      </div>
      <FormTextarea
        label="Recipients"
        value={recipients}
        onChange={setRecipients}
        rows={3}
        required
        placeholder={"noc@example.com\ncustomer@example.com"}
        error={fieldErrors.recipients}
      />
      <FormCheckbox label="On" checked={enabled} onChange={setEnabled} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : s ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  )
}
