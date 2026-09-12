import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CheckListRow } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { SortHeader } from "@/components/data-table"
import { SourceBadge, SourceHeader } from "@/components/monitoring/source-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { StatusStrip } from "@/components/monitoring/status-strip"
import { FastBadge } from "@/components/monitoring/fast-badge"

export type CheckColumnId =
  | "status"
  | "ip"
  | "device"
  | "site"
  | "check"
  | "kind"
  | "source"
  | "strip"
  | "latency"
  | "since"
  | "last_checked"

/** Column id → the `ordering` key the checks endpoint sorts by. Every
 * sortable column is here; the strip is not. */
export const CHECK_ORDERING: Partial<Record<CheckColumnId, string>> = {
  status: "status",
  ip: "ip",
  device: "device",
  site: "site",
  check: "check",
  kind: "kind",
  source: "source",
  latency: "latency",
  since: "since",
  last_checked: "last_checked",
}

/** A monitored check, as a row of the Checks list. `strip` is the window the
 * server drew the segments over; without it the column is left out. */
export function checkColumns(
  strip?: { since: string; until: string } | null
): ColumnDef<CheckListRow>[] {
  const cols: ColumnDef<CheckListRow>[] = [
    {
      id: "status",
      accessorFn: (r) => r.status,
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <CheckStatusBadge status={row.original.status} />,
    },
    {
      id: "ip",
      accessorFn: (r) => r.target_ip.ip_address,
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) => {
        const ip = row.original.target_ip
        return (
          <span className="inline-flex min-w-0 items-baseline gap-1.5">
            <Link
              to="/ips/$id"
              params={{ id: ip.id }}
              search={{ tab: "monitoring" }}
              className="link font-mono font-medium"
            >
              {ip.ip_address}
            </Link>
            {ip.dns_name && (
              <span className="truncate text-[11px] text-muted-foreground">
                {ip.dns_name}
              </span>
            )}
          </span>
        )
      },
    },
    {
      id: "device",
      accessorFn: (r) => r.device?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => {
        const d = row.original.device
        if (!d) return dash
        return (
          <Link
            to="/devices/$id"
            params={{ id: d.id }}
            search={{ tab: "monitoring" }}
            className="link"
          >
            {d.name}
          </Link>
        )
      },
    },
    {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => {
        const s = row.original.site
        if (!s) return dash
        return (
          <Link to="/sites/$id" params={{ id: s.id }} className="link">
            {s.name}
          </Link>
        )
      },
    },
    {
      id: "check",
      accessorFn: (r) => r.template.name,
      header: ({ column }) => <SortHeader column={column} label="Check" />,
      cell: ({ row }) => row.original.template.name,
    },
    {
      id: "kind",
      accessorFn: (r) => r.kind,
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground uppercase">
            {row.original.kind}
          </span>
          {row.original.interval_ms && (
            <FastBadge intervalMs={row.original.interval_ms} />
          )}
        </span>
      ),
    },
    {
      id: "source",
      accessorFn: (r) => r.source,
      header: ({ column }) => (
        <span className="inline-flex items-center">
          <SortHeader column={column} label="" />
          <SourceHeader />
        </span>
      ),
      cell: ({ row }) => (
        <SourceBadge
          source={row.original.source}
          engine={row.original.engine}
        />
      ),
    },
  ]
  if (strip) {
    cols.push({
      id: "strip",
      enableSorting: false,
      header: "7 days",
      cell: ({ row }) => (
        <span className="block w-40">
          <StatusStrip
            segments={row.original.segments ?? []}
            since={strip.since}
            until={strip.until}
            scope={{
              ip: row.original.target_ip.id,
              template: row.original.template.id,
            }}
          />
        </span>
      ),
    })
  }
  cols.push(
    {
      id: "latency",
      accessorFn: (r) => r.last_latency_ms ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Latency" />,
      cell: ({ row }) => (
        <span className="num text-muted-foreground">
          {row.original.last_latency_ms != null
            ? `${row.original.last_latency_ms.toFixed(1)} ms`
            : "-"}
        </span>
      ),
    },
    {
      id: "since",
      accessorFn: (r) => r.since ?? "",
      header: ({ column }) => <SortHeader column={column} label="Since" />,
      cell: ({ row }) =>
        row.original.since ? <TimeCell iso={row.original.since} /> : dash,
    },
    {
      id: "last_checked",
      accessorFn: (r) => r.last_checked ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Last checked" />
      ),
      cell: ({ row }) =>
        row.original.last_checked ? (
          <TimeCell iso={row.original.last_checked} />
        ) : (
          <span className="text-xs text-muted-foreground">never</span>
        ),
    }
  )
  return cols
}
