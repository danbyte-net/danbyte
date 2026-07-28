import type { ColumnDef } from "@tanstack/react-table"

import type { DeployRun } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { DeployRunStatus } from "@/components/deploy-run-status"
import { DeployRetryButton } from "@/components/deploy-retry-button"

// The one source of truth for "a table of deploy runs". The /deploy-runs list
// and the Runs tab on an automation target both build their columns here, so a
// run row reads identically in both places — the target page just omits the
// "target" column it would otherwise repeat on every row.

export type DeployRunColumnId =
  | "target"
  | "status"
  | "event"
  | "devices"
  | "detail"
  | "created"
  | "retry"

const CANONICAL_ORDER: DeployRunColumnId[] = [
  "target",
  "status",
  "event",
  "devices",
  "detail",
  "created",
  "retry",
]

export interface DeployRunColumnOpts {
  /** Drop columns (the automation-target page omits its own "target"). */
  omit?: DeployRunColumnId[]
}

/** Dispatch latency (enqueue → terminal), compact: 850ms · 1.2s · 2m 3s. */
export function formatDeployDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export function buildDeployRunColumns(
  opts: DeployRunColumnOpts = {}
): ColumnDef<DeployRun, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<DeployRunColumnId, () => ColumnDef<DeployRun, unknown>> = {
    target: () => ({
      id: "target",
      accessorKey: "target_name",
      header: "Target",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.target_name}</span>
      ),
    }),
    status: () => ({
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <DeployRunStatus status={row.original.status} />
          {row.original.attempt > 1 && (
            <Badge variant="outline" className="text-[10px]">
              attempt {row.original.attempt}
            </Badge>
          )}
        </span>
      ),
    }),
    event: () => ({
      id: "event",
      accessorKey: "event",
      header: "Trigger",
      cell: ({ row }) => (
        <Badge variant="outline" className="text-[10px]">
          {row.original.event}
        </Badge>
      ),
    }),
    devices: () => ({
      id: "devices",
      header: "Devices",
      cell: ({ row }) => (
        <span className="num text-xs text-muted-foreground">
          {row.original.device_ids.length}
        </span>
      ),
    }),
    detail: () => ({
      id: "detail",
      accessorKey: "detail",
      header: "Detail",
      cell: ({ row }) => (
        <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
          {row.original.detail || "—"}
        </span>
      ),
    }),
    created: () => ({
      id: "created",
      header: "When",
      cell: ({ row }) => (
        <div className="text-right">
          <TimeCell iso={row.original.created_at} align="right" />
          {row.original.duration_ms != null && (
            <div className="num text-[10px] text-muted-foreground">
              {formatDeployDuration(row.original.duration_ms)}
            </div>
          )}
        </div>
      ),
    }),
    retry: () => ({
      id: "actions",
      enableHiding: false,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <DeployRetryButton run={row.original} />
        </div>
      ),
    }),
  }

  return CANONICAL_ORDER.filter((id) => !omit.has(id)).map((id) => byId[id]())
}
