import type { ColumnDef } from "@tanstack/react-table"

import type { SlaReportSchedule } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]

const FORMAT_LABEL = { pdf: "PDF", csv: "CSV", both: "PDF and CSV" } as const

/** "Mondays 07:00" or "Day 1, 07:00". */
export function scheduleWhen(s: SlaReportSchedule): string {
  const hour = `${String(s.hour).padStart(2, "0")}:00`
  return s.frequency === "weekly"
    ? `${WEEKDAYS[s.weekday]}s ${hour}`
    : `Day ${s.day_of_month}, ${hour}`
}

export function ScheduleState({ s }: { s: SlaReportSchedule }) {
  if (!s.enabled) return <Badge variant="secondary">Off</Badge>
  if (s.failures > 0)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="destructive">Failing · {s.failures}</Badge>
        </TooltipTrigger>
        <TooltipContent variant="default" className="max-w-80">
          {s.last_error}
        </TooltipContent>
      </Tooltip>
    )
  return <Badge variant="success">On</Badge>
}

/** A scheduled SLA report, as a row of an agreement's or the overview's
 * schedules. */
export function slaReportScheduleColumns(): ColumnDef<SlaReportSchedule>[] {
  return [
    {
      id: "when",
      accessorFn: (r) => scheduleWhen(r),
      header: "When",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{scheduleWhen(row.original)}</span>
      ),
    },
    {
      id: "period",
      accessorFn: (r) => r.period,
      header: "Period",
      cell: ({ row }) =>
        row.original.period === "current" ? "This period" : "Last period",
    },
    {
      id: "recipients",
      accessorFn: (r) => r.recipients.join(", "),
      header: "Recipients",
      cell: ({ row }) => row.original.recipients.join(", "),
    },
    {
      id: "format",
      accessorFn: (r) => r.report_format,
      header: "As",
      cell: ({ row }) => FORMAT_LABEL[row.original.report_format],
    },
    {
      id: "state",
      accessorFn: (r) => (r.enabled ? r.failures : -1),
      header: "State",
      cell: ({ row }) => <ScheduleState s={row.original} />,
    },
    {
      id: "sent",
      accessorFn: (r) => r.report_sent_at ?? "",
      header: "Last sent",
      cell: ({ row }) =>
        row.original.report_sent_at ? (
          <TimeCell iso={row.original.report_sent_at} />
        ) : (
          dash
        ),
    },
    {
      id: "next",
      accessorFn: (r) => r.next_at ?? "",
      header: "Next",
      cell: ({ row }) =>
        row.original.next_at ? <TimeCell iso={row.original.next_at} /> : dash,
    },
  ]
}
