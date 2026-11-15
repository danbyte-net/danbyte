import type { ColumnDef } from "@tanstack/react-table"

import type { DependencyProposal } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { DependencyEndCell } from "@/components/columns/device-dependency-columns"
import { DependencyMediumBadge } from "@/components/dependency-medium-badge"
import { Badge } from "@/components/ui/badge"

// The one table of dependency proposals (#450): the review step of
// "Suggest from cables and LLDP". Each row is a dependency that would be
// created; `refusals` holds the server's answer for a row it refused.

/** A proposal as a table row: keyed by its `key`. */
export type ProposalRow = DependencyProposal & { id: string }

export interface DependencyProposalColumnOpts {
  /** The refusal per proposal key, from the last confirm. */
  refusals?: ReadonlyMap<string, string>
}

const EVIDENCE: Record<string, string> = { cable: "Cable", lldp: "LLDP" }

export function buildDependencyProposalColumns(
  opts: DependencyProposalColumnOpts = {}
): ColumnDef<ProposalRow, unknown>[] {
  const cols: ColumnDef<ProposalRow, unknown>[] = [
    selectionColumn<ProposalRow>(),
    {
      id: "downstream",
      accessorFn: (r) => r.downstream.name,
      header: ({ column }) => <SortHeader column={column} label="Downstream" />,
      cell: ({ row }) => <DependencyEndCell end={row.original.downstream} />,
    },
    {
      id: "upstream",
      accessorFn: (r) => r.upstream.name,
      header: ({ column }) => <SortHeader column={column} label="Upstream" />,
      cell: ({ row }) => <DependencyEndCell end={row.original.upstream} />,
    },
    {
      id: "medium",
      accessorFn: (r) => r.medium?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Medium" />,
      cell: ({ row }) =>
        row.original.medium ? (
          <DependencyMediumBadge medium={row.original.medium} />
        ) : (
          dash
        ),
    },
    {
      id: "redundancy_group",
      accessorKey: "redundancy_group",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      cell: ({ row }) =>
        row.original.redundancy_group ? (
          <span className="font-mono text-xs">
            {row.original.redundancy_group}
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "evidence",
      accessorKey: "evidence",
      header: ({ column }) => <SortHeader column={column} label="Evidence" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-1">
          <Badge variant="secondary">
            {EVIDENCE[row.original.evidence] ?? row.original.evidence}
          </Badge>
          {row.original.direction === "uplink" && (
            <Badge variant="outline">Uplink</Badge>
          )}
        </span>
      ),
    },
    {
      id: "hops",
      accessorKey: "distance",
      header: ({ column }) => <SortHeader column={column} label="Hops" />,
      cell: ({ row }) => <span className="num">{row.original.distance}</span>,
    },
    {
      id: "ports",
      accessorFn: (r) =>
        r.ports.map((p) => `${p.downstream} ↔ ${p.upstream}`).join(", "),
      header: "Ports",
      cell: ({ getValue }) => (
        <span className="line-clamp-1 block text-xs text-muted-foreground">
          {String(getValue()) || "-"}
        </span>
      ),
    },
  ]
  if (opts.refusals?.size)
    cols.push({
      id: "refusal",
      accessorFn: (r) => opts.refusals?.get(r.key) ?? "",
      header: "Refused",
      cell: ({ getValue }) => (
        <span className="block text-xs text-destructive">
          {String(getValue())}
        </span>
      ),
    })
  return cols
}
