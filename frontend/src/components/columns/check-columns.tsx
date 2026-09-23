import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CheckListRow } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { SortHeader } from "@/components/data-table"
import { SourceBadge, SourceHeader } from "@/components/monitoring/source-badge"
import { FlappingPill } from "@/components/monitoring/flapping-pill"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { StatusStrip } from "@/components/monitoring/status-strip"
import { FastBadge } from "@/components/monitoring/fast-badge"
import { AvailabilityCell, fmtMs } from "@/components/monitoring/availability"

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
  | "availability"
  | "p95"
  | "baseline"
  | "ratio"
  | "spikes"

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
  strip?: {
    since: string
    until: string
    /** The column header - the window's name. */
    label?: string
    /** A wide strip, for a view where the run itself is the picture. */
    wide?: boolean
  } | null,
  /** Adds the rollup columns - rows must come from `?with=figures`.
   * `offenders` adds the latency page's two: p95 against baseline, spikes. */
  figures?: { label: string; offenders?: boolean } | null
): ColumnDef<CheckListRow & { ratio?: number | null }>[] {
  const cols: ColumnDef<CheckListRow & { ratio?: number | null }>[] = [
    {
      id: "status",
      accessorFn: (r) => r.status,
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <CheckStatusBadge status={row.original.status} />
          {row.original.flapping_since && <FlappingPill />}
        </span>
      ),
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
      cell: ({ row }) => (
        <Link
          to="/monitoring/checks/$id"
          params={{ id: row.original.id }}
          className="link"
        >
          {row.original.template.name}
        </Link>
      ),
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
      header: strip.label ?? "7 days",
      cell: ({ row }) => (
        <span className={strip.wide ? "block w-full min-w-64" : "block w-40"}>
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
  if (figures) {
    cols.push(
      {
        id: "availability",
        enableSorting: false,
        accessorFn: (r) => r.figures?.availability ?? -1,
        header: `Availability ${figures.label}`,
        cell: ({ row }) => <AvailabilityCell figures={row.original.figures} />,
      },
      {
        id: "p95",
        enableSorting: false,
        accessorFn: (r) => r.figures?.p95 ?? -1,
        header: `p95 ${figures.label}`,
        cell: ({ row }) => (
          <span className="num text-muted-foreground">
            {fmtMs(row.original.figures?.p95)}
          </span>
        ),
      },
      {
        id: "baseline",
        enableSorting: false,
        accessorFn: (r) => r.baseline_ms ?? -1,
        header: "Baseline",
        cell: ({ row }) => (
          <span className="num text-muted-foreground">
            {fmtMs(row.original.baseline_ms)}
          </span>
        ),
      }
    )
    if (figures.offenders)
      cols.push(
        {
          id: "ratio",
          enableSorting: false,
          accessorFn: (r) => r.ratio ?? -1,
          header: "Against baseline",
          cell: ({ row }) =>
            row.original.ratio == null ? (
              dash
            ) : (
              <span className="num">{row.original.ratio.toFixed(1)}x</span>
            ),
        },
        {
          id: "spikes",
          enableSorting: false,
          accessorFn: (r) => r.figures?.spikes ?? 0,
          header: "Spikes",
          cell: ({ row }) => (
            <span className="num">{row.original.figures?.spikes ?? 0}</span>
          ),
        }
      )
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
