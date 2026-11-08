import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { TopologyViewListRow } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"

/** A saved topology view, as a row of the Topology page's list. The name
 * opens the view on the map. `selection` adds the leading checkbox column
 * for bulk selection. */
export function topologyViewColumns(
  opts: { selection?: boolean } = {}
): ColumnDef<TopologyViewListRow>[] {
  return [
    ...(opts.selection ? [selectionColumn<TopologyViewListRow>()] : []),
    {
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="View" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <Link
            to="/topology/map"
            search={{ view: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          {row.original.is_default && (
            <Badge variant="secondary">Default</Badge>
          )}
        </span>
      ),
    },
    {
      id: "created_by",
      accessorFn: (r) => r.created_by,
      header: ({ column }) => <SortHeader column={column} label="Created by" />,
      cell: ({ row }) => row.original.created_by || dash,
    },
    {
      id: "updated_by",
      accessorFn: (r) => r.updated_by,
      header: ({ column }) => <SortHeader column={column} label="Updated by" />,
      cell: ({ row }) => row.original.updated_by || dash,
    },
    {
      id: "updated",
      accessorFn: (r) => r.updated_at,
      header: ({ column }) => <SortHeader column={column} label="Updated" />,
      cell: ({ row }) => <TimeCell iso={row.original.updated_at} />,
    },
  ]
}
