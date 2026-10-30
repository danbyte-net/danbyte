import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Room } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { locationColumn } from "@/components/cells/location-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of rooms". /rooms and the Rooms tab on
// a location's page build their columns here, so a room row reads the same
// everywhere. The name renders as the room's colour badge - the colour comes
// from the room's own data.

export type RoomColumnId =
  | "numid"
  | "name"
  | "code"
  | "site"
  | "location"
  | "status"
  | "devices"
  | "racks"
  | "cabinets"
  | "tags"
  | "description"
  | "updated"

const CANONICAL_ORDER: RoomColumnId[] = [
  "numid",
  "name",
  "code",
  "site",
  "location",
  "status",
  "devices",
  "racks",
  "cabinets",
  "tags",
  "description",
  "updated",
]

export interface RoomColumnOpts<T extends Room = Room> {
  /** Drop columns (e.g. "location" on a location's own page). */
  omit?: RoomColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: RoomColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

function countColumn<T extends Room>(
  id: "devices" | "racks" | "cabinets",
  label: string,
  get: (r: T) => number
): ColumnDef<T, unknown> {
  return {
    id,
    accessorFn: get,
    header: ({ column }) => <SortHeader column={column} label={label} />,
    cell: ({ row }) => {
      const n = get(row.original)
      return n ? <span className="num text-xs">{n}</span> : dash
    },
    meta: { field: `${id.slice(0, -1)}_count` },
  }
}

export function buildRoomColumns<T extends Room = Room>(
  opts: RoomColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: RoomColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<RoomColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/rooms/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            <ColorBadge
              name={row.original.name}
              color={row.original.color || undefined}
            />
          </Link>
          <PlannedChangeMarker
            objectType="api.room"
            objectId={row.original.id}
          />
        </span>
      ),
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
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    location: () =>
      locationColumn<T>({ get: (r) => r.location, className: "text-xs" }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
            textColor: r.status?.text_color,
          }),
        },
      },
    }),
    devices: () => countColumn<T>("devices", "Devices", (r) => r.device_count),
    racks: () => countColumn<T>("racks", "Racks", (r) => r.rack_count),
    cabinets: () =>
      countColumn<T>("cabinets", "Cabinets", (r) => r.cabinet_count),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
