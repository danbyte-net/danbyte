import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { CornerDownRight } from "lucide-react"

import type { Location } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { LocationCell } from "@/components/cells/location-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of locations": /locations and the
// Locations tab on a location type's page build their columns here. A
// location is drawn in its own colour and icon, else its type's.

export type LocationColumnId =
  "numid" | "name" | "code" | "type" | "site" | "parent" | "status" | "children"

const CANONICAL_ORDER: LocationColumnId[] = [
  "numid",
  "name",
  "code",
  "type",
  "site",
  "parent",
  "status",
  "children",
]

/** The colour a location is drawn in: its own, else its type's. */
export function locationColor(l: Pick<Location, "color" | "location_type">) {
  return l.color || l.location_type?.color || ""
}

/** The icon a location is drawn with: its own, else its type's. */
export function locationIcon(l: Pick<Location, "icon" | "location_type">) {
  return l.icon || l.location_type?.icon || ""
}

export interface LocationColumnOpts<T extends Location = Location> {
  omit?: LocationColumnId[]
  selection?: boolean
  humanIds?: boolean
  /** Indent each row by its `_depth` (the tree order of the list page). */
  nested?: boolean
  actions?: ActionsColumnOpts<T>
}

export function buildLocationColumns<T extends Location = Location>(
  opts: LocationColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")

  const byId: Record<LocationColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => {
        const depth = opts.nested
          ? ((row.original as T & { _depth?: number })._depth ?? 0)
          : 0
        const color = locationColor(row.original)
        const icon = locationIcon(row.original)
        return (
          <div className="flex items-center gap-0.5">
            {Array.from({ length: depth }, (_, i) => (
              <CornerDownRight
                key={i}
                aria-hidden
                className="h-3 w-3 shrink-0 text-muted-foreground/40"
              />
            ))}
            {(color || icon) && (
              <TileBadge color={color} icon={icon} className="mr-1.5 h-4 w-4" />
            )}
            <Link
              to="/locations/$id"
              params={{ id: row.original.id }}
              className="link font-medium"
            >
              {row.original.name}
            </Link>
          </div>
        )
      },
    }),
    code: () => ({
      id: "code",
      accessorKey: "code",
      header: ({ column }) => <SortHeader column={column} label="Code" />,
      cell: ({ row }) =>
        row.original.code ? (
          <span className="font-mono text-xs">{row.original.code}</span>
        ) : (
          dash
        ),
    }),
    type: () => ({
      id: "type",
      accessorFn: (r) => r.location_type?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => {
        const t = row.original.location_type
        return t ? (
          <Link to="/location-types/$id" params={{ id: t.id }}>
            <ColorBadge name={t.name} color={t.color || undefined} />
          </Link>
        ) : (
          dash
        )
      },
      meta: {
        field: "location_type",
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.location_type?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.location_type?.name ?? "No type",
            color: r.location_type?.color || undefined,
          }),
        },
      },
    }),
    site: () => siteColumn<T>({ get: (l) => l.site }),
    parent: () => ({
      id: "parent",
      accessorFn: (l) => l.parent?.name ?? "",
      header: "Parent",
      cell: ({ row }) => (
        <LocationCell location={row.original.parent} className="text-xs" />
      ),
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.status?.name ?? "No status",
            color: sample.status?.color,
            textColor: sample.status?.text_color,
          }),
        },
      },
    }),
    children: () => ({
      id: "children",
      accessorKey: "child_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Sub-locations" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.child_count}</span>
      ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
