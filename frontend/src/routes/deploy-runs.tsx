import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api, type DeployRun, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { DeployRunStatus } from "@/components/deploy-run-status"
import { AutomationExplainer } from "@/components/automation-explainer"
import { DeployRetryButton } from "@/components/deploy-retry-button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/deploy-runs")({
  component: DeployRunsPage,
})

const STATUSES = ["queued", "launched", "failed"] as const

// Dispatch latency (enqueue → terminal), compact: 850ms · 1.2s · 2m 3s.
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

function DeployRunsPage() {
  const [status, setStatus] = useState<string>("all")

  const query = useQuery({
    queryKey: ["deploy-runs", status],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status !== "all") p.set("status", status)
      return api<Paginated<DeployRun>>(`/api/deploy-runs/?${p.toString()}`)
    },
    refetchInterval: 10_000,
  })

  const rows = query.data?.results ?? []
  const columns = useMemo<ColumnDef<DeployRun>[]>(
    () => [
      {
        id: "target",
        accessorKey: "target_name",
        header: "Target",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.target_name}</span>
        ),
      },
      {
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
      },
      {
        id: "event",
        accessorKey: "event",
        header: "Trigger",
        cell: ({ row }) => (
          <Badge variant="outline" className="text-[10px]">
            {row.original.event}
          </Badge>
        ),
      },
      {
        id: "devices",
        header: "Devices",
        cell: ({ row }) => (
          <span className="num text-xs text-muted-foreground">
            {row.original.device_ids.length}
          </span>
        ),
      },
      {
        id: "detail",
        accessorKey: "detail",
        header: "Detail",
        cell: ({ row }) => (
          <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
            {row.original.detail || "—"}
          </span>
        ),
      },
      {
        id: "created",
        header: "When",
        cell: ({ row }) => (
          <div className="text-right">
            <TimeCell iso={row.original.created_at} align="right" />
            {row.original.duration_ms != null && (
              <div className="num text-[10px] text-muted-foreground">
                {fmtDuration(row.original.duration_ms)}
              </div>
            )}
          </div>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <DeployRetryButton run={row.original} />
          </div>
        ),
      },
    ],
    []
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="text-base font-semibold">Deploy runs</h1>
        {query.data && <Badge variant="secondary">{rows.length}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <div className="flex-1 space-y-4 overflow-auto p-4 lg:p-6">
        <AutomationExplainer variant="note" />
        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {query.isError && <QueryError error={query.error} />}
        {query.data &&
          (rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deploy runs yet. Deploy a device from its Config tab, or enable{" "}
              <span className="font-medium">Auto-deploy on change</span> on an
              automation target.
            </p>
          ) : (
            <DataTable
              data={rows}
              columns={columns}
              flexColumn="detail"
              tableId="deploy-runs"
            />
          ))}
      </div>
    </div>
  )
}
