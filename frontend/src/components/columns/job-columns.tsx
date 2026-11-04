import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { JobBrief } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"

// The one source of truth for "a table of background jobs" - the Queue tab
// of /jobs builds here; the job page shares the state badge and duration.

type Variant = "secondary" | "info" | "success" | "destructive" | "warning"

// state → display label + badge tint, so the list and the job page agree.
export const STATE_META: Record<
  string,
  { label: string; variant: Variant } | undefined
> = {
  queued: { label: "Queued", variant: "secondary" },
  started: { label: "Running", variant: "info" },
  deferred: { label: "Deferred", variant: "warning" },
  scheduled: { label: "Scheduled", variant: "secondary" },
  finished: { label: "Finished", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
}

export function StateBadge({ state }: { state: string }) {
  const meta = STATE_META[state] ?? {
    label: state,
    variant: "secondary" as const,
  }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

// Seconds → compact human duration.
export function fmtDuration(s: number | null): string {
  if (s == null) return "-"
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function buildJobColumns(
  opts: {
    /** Leading checkbox column for bulk selection. */
    selection?: boolean
  } = {}
): ColumnDef<JobBrief, unknown>[] {
  const cols: ColumnDef<JobBrief, unknown>[] = [
    {
      id: "status",
      accessorFn: (r) => r.state,
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StateBadge state={row.original.state} />,
    },
    {
      id: "job",
      header: "Job",
      cell: ({ row }) => {
        const j = row.original
        return (
          <div>
            <div className="flex items-center gap-2">
              <Link
                to="/jobs/$id"
                params={{ id: j.id }}
                className="link truncate font-mono text-[13px] font-medium"
              >
                {j.func_short}
              </Link>
              {j.corrupt && (
                <Badge variant="warning" className="shrink-0">
                  unreadable
                </Badge>
              )}
            </div>
            {j.description && (
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {j.description}
              </div>
            )}
          </div>
        )
      },
    },
    {
      id: "queue",
      header: "Queue",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.queue}
        </span>
      ),
    },
    {
      id: "worker",
      header: "Worker",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.worker_name
            ? row.original.worker_name.slice(0, 12)
            : "-"}
        </span>
      ),
    },
    {
      id: "enqueued",
      header: "Enqueued",
      cell: ({ row }) =>
        row.original.enqueued_at ? (
          <TimeCell iso={row.original.enqueued_at} />
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "duration",
      header: () => <span className="block text-right">Duration</span>,
      cell: ({ row }) => (
        <span className="block text-right font-mono text-[12px] text-muted-foreground tabular-nums">
          {fmtDuration(row.original.duration)}
        </span>
      ),
    },
  ]
  return opts.selection ? [selectionColumn<JobBrief>(), ...cols] : cols
}
