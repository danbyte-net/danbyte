import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { NamedDashboard } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { SortHeader } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"

const VISIBILITY: Record<NamedDashboard["visibility"], string> = {
  private: "Only me",
  tenant: "Tenant",
  groups: "Groups",
}

/** A named dashboard, as a row of the dashboards list. */
export function dashboardColumns(): ColumnDef<NamedDashboard>[] {
  return [
    {
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Dashboard" />,
      cell: ({ row }) => (
        <Link
          to="/dashboards/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "description",
      accessorFn: (r) => r.description,
      header: "Description",
      cell: ({ row }) => row.original.description || dash,
    },
    {
      id: "owner",
      accessorFn: (r) => r.owner_name,
      header: ({ column }) => <SortHeader column={column} label="Owner" />,
      cell: ({ row }) => row.original.owner_name,
      meta: {
        facet: {
          kind: "enum" as const,
          label: "Owner",
          get: (r: NamedDashboard) => r.owner_name,
        },
      },
    },
    {
      id: "visibility",
      accessorFn: (r) => r.visibility,
      header: "Shared with",
      cell: ({ row }) => (
        <Badge variant="secondary">{VISIBILITY[row.original.visibility]}</Badge>
      ),
      meta: {
        facet: {
          kind: "enum" as const,
          label: "Shared with",
          get: (r: NamedDashboard) => r.visibility,
          formatValue: (v: string) => ({
            label: VISIBILITY[v as NamedDashboard["visibility"]],
          }),
        },
      },
    },
    {
      id: "widgets",
      accessorFn: (r) => ("items" in r.layout ? r.layout.items.length : 0),
      header: "Widgets",
      cell: ({ row }) => (
        <span className="num">
          {"items" in row.original.layout
            ? row.original.layout.items.length
            : 0}
        </span>
      ),
    },
    {
      id: "updated",
      accessorFn: (r) => r.updated_at,
      header: ({ column }) => <SortHeader column={column} label="Updated" />,
      cell: ({ row }) => <TimeCell iso={row.original.updated_at} />,
    },
  ]
}
