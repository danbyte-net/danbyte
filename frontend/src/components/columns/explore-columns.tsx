import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ExploreDimension, ExploreRow } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { ColorBadge } from "@/components/cells/color-badge"
import { Badge } from "@/components/ui/badge"
import { AvailabilityCell, fmtMs } from "@/components/monitoring/availability"
import { fmtSpan } from "@/components/monitoring/status-strip"

const NONE: Record<ExploreDimension, string> = {
  site: "No site",
  role: "No device",
  device_type: "No device",
  platform: "No platform",
  device: "No device",
  prefix: "No prefix",
  vrf: "Global",
  template: "No check",
  kind: "-",
}

/** One group of checks on the explore view. The name opens the checks list
 * filtered to that group - the same URL param the list's rail writes. */
export function exploreColumns(
  groupBy: ExploreDimension
): ColumnDef<ExploreRow>[] {
  return [
    {
      id: "name",
      accessorFn: (r) => r.name ?? "",
      header: "Group",
      cell: ({ row }) => {
        const r = row.original
        if (r.key == null)
          return <span className="text-muted-foreground">{NONE[groupBy]}</span>
        const label = r.color ? (
          <ColorBadge name={r.name ?? ""} color={r.color} />
        ) : groupBy === "kind" ? (
          <span className="font-mono text-[12px] uppercase">{r.name}</span>
        ) : groupBy === "prefix" ? (
          <span className="font-mono">{r.name}</span>
        ) : (
          r.name
        )
        return (
          <Link
            to="/monitoring"
            search={{ view: "checks", status: "all", [groupBy]: r.key }}
            className="link"
          >
            {label}
          </Link>
        )
      },
    },
    {
      id: "checks",
      accessorFn: (r) => r.checks,
      header: "Checks",
      cell: ({ row }) => <span className="num">{row.original.checks}</span>,
    },
    {
      id: "availability",
      accessorFn: (r) => r.availability ?? -1,
      header: "Availability",
      cell: ({ row }) => <AvailabilityCell figures={row.original} />,
    },
    {
      id: "incidents",
      accessorFn: (r) => r.incidents,
      header: "Incidents",
      cell: ({ row }) => <span className="num">{row.original.incidents}</span>,
    },
    {
      id: "mttr",
      accessorFn: (r) => r.mttr_s ?? -1,
      header: "Time to recover",
      cell: ({ row }) =>
        row.original.mttr_s == null ? (
          dash
        ) : (
          <span className="num">{fmtSpan(row.original.mttr_s * 1000)}</span>
        ),
    },
    {
      id: "latency",
      enableSorting: false,
      header: "Latency p50 / p95",
      cell: ({ row }) => {
        const kinds = row.original.latency
        if (!kinds.length) return dash
        return (
          <span className="flex flex-wrap gap-1">
            {kinds.map((k) => (
              <Badge
                key={k.kind}
                variant="secondary"
                className="num font-normal"
              >
                <span className="font-mono text-[10px] uppercase">
                  {k.kind}
                </span>
                {fmtMs(k.p50)} / {fmtMs(k.p95)}
              </Badge>
            ))}
          </span>
        )
      },
    },
  ]
}
