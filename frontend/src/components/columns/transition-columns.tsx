import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { TransitionRow } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { detailSummary } from "@/components/monitoring/check-history"
import { SourceBadge, SourceHeader } from "@/components/monitoring/source-badge"
import { FlappingPill } from "@/components/monitoring/flapping-pill"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"

export type TransitionColumnId =
  | "at"
  | "target"
  | "device"
  | "site"
  | "check"
  | "change"
  | "source"
  | "detail"

/** A status change, the same row on the history page and inside a target's
 * History panel. Server-sorted: the rows are one page of many, so the headers
 * do not carry the client sort. */
export function transitionColumns(
  omit: TransitionColumnId[] = []
): ColumnDef<TransitionRow>[] {
  const all: Record<TransitionColumnId, ColumnDef<TransitionRow>> = {
    at: {
      id: "at",
      accessorFn: (r) => r.at,
      header: "When",
      cell: ({ row }) => <TimeCell iso={row.original.at} />,
    },
    target: {
      id: "target",
      accessorFn: (r) => r.target_ip?.ip_address ?? "",
      header: "Address",
      cell: ({ row }) => {
        const ip = row.original.target_ip
        if (!ip) return dash
        return (
          <span className="inline-flex min-w-0 items-baseline gap-1.5">
            <Link
              to="/ips/$id"
              params={{ id: ip.id }}
              search={{ tab: "monitoring" }}
              className="link font-mono"
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
    device: {
      id: "device",
      accessorFn: (r) => r.device?.name ?? "",
      header: "Device",
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
    site: {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: "Site",
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
    check: {
      id: "check",
      accessorFn: (r) => r.template?.name ?? r.kind,
      header: "Check",
      cell: ({ row }) => (
        <span className="inline-flex items-baseline gap-1.5">
          <span>{row.original.template?.name ?? row.original.kind}</span>
          <span className="font-mono text-[10px] text-muted-foreground uppercase">
            {row.original.kind}
          </span>
          {row.original.flapping && <FlappingPill />}
        </span>
      ),
    },
    change: {
      id: "change",
      accessorFn: (r) => `${r.from_status}>${r.to_status}`,
      header: "Change",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <CheckStatusBadge status={row.original.from_status} />
          <span className="text-muted-foreground">→</span>
          <CheckStatusBadge status={row.original.to_status} />
        </span>
      ),
    },
    source: {
      id: "source",
      accessorFn: (r) => r.source,
      header: () => <SourceHeader />,
      cell: ({ row }) => (
        <SourceBadge
          source={row.original.source}
          engine={row.original.engine}
        />
      ),
    },
    detail: {
      id: "detail",
      accessorFn: (r) => detailSummary(r.detail),
      header: "Detail",
      cell: ({ row }) => (
        <span className="block truncate text-xs text-muted-foreground">
          {detailSummary(row.original.detail)}
        </span>
      ),
    },
  }
  return (Object.keys(all) as TransitionColumnId[])
    .filter((id) => !omit.includes(id))
    .map((id) => all[id])
}
