import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { AreaType } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { DynamicIcon } from "@/components/dynamic-icon"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import { AreaSwatch } from "@/components/floorplan/area-legend"
import { AREA_PATTERNS } from "@/components/floorplan/shapes"

// The one source of truth for "a table of area types". The name renders as
// the type's colour badge - the colour comes from the type's own data.

export interface AreaTypeColumnOpts<T extends AreaType = AreaType> {
  selection?: boolean
  humanIds?: boolean
  actions?: ActionsColumnOpts<T>
}

const patternLabel = (p: string) =>
  AREA_PATTERNS.find((x) => x.value === p)?.label ?? p

export function buildAreaTypeColumns<T extends AreaType = AreaType>(
  opts: AreaTypeColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  if (opts.humanIds) cols.push(numidColumn<T>({ get: (r) => r.numid }))
  cols.push(
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/area-types/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
    },
    {
      id: "pattern",
      accessorKey: "pattern",
      header: "Pattern",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5 text-xs">
          <AreaSwatch type={row.original} />
          {patternLabel(row.original.pattern)}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Pattern",
          get: (r: T) => r.pattern,
          formatValue: (v) => ({ label: patternLabel(String(v)) }),
        },
      },
    },
    {
      id: "icon",
      accessorKey: "icon",
      header: "Icon",
      cell: ({ row }) =>
        row.original.icon ? (
          <span className="inline-flex items-center gap-1.5">
            <DynamicIcon
              name={row.original.icon}
              className="h-3.5 w-3.5 text-muted-foreground"
            />
            <span className="font-mono text-xs">{row.original.icon}</span>
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "areas",
      accessorKey: "area_count",
      header: ({ column }) => <SortHeader column={column} label="Areas" />,
      cell: ({ row }) =>
        row.original.area_count ? (
          <span className="num text-xs">{row.original.area_count}</span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Areas",
          get: (r: T) => (r.area_count > 0 ? "in" : "out"),
          formatValue: (v) => ({ label: v === "in" ? "In use" : "Unused" }),
        },
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    },
    timeAgoColumn<T>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    })
  )
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
