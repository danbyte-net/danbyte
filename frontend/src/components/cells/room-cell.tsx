import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { RoomRef } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"

// Canonical "render a Room reference" + "Room column" pair. A room is a
// coloured object: it renders as its ColorBadge (colour from the room's own
// data), linked to /rooms/$id, wherever a device, rack or cabinet names it.
//
//   <RoomCell room={...} />
//   roomColumn<MyRow>({ get: r => r.room })

export interface RoomCellProps {
  room: RoomRef | null | undefined
  /** Wrap the badge in a /rooms/$id link. Default true. */
  linked?: boolean
  className?: string
}

export function RoomCell({ room, linked = true, className }: RoomCellProps) {
  if (!room) return <span className="text-muted-foreground">-</span>
  const badge = (
    <ColorBadge
      name={room.name}
      color={room.color || undefined}
      className={className}
    />
  )
  if (!linked) return badge
  return (
    <Link to="/rooms/$id" params={{ id: room.id }} className="link">
      {badge}
    </Link>
  )
}

export interface RoomColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => RoomRef | null | undefined
  linked?: boolean
}

export function roomColumn<T>(opts: RoomColumnOpts<T>): ColumnDef<T, unknown> {
  const id = opts.id ?? "room"
  const header = opts.header ?? "Room"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <RoomCell room={opts.get(row.original)} linked={opts.linked} />
    ),
    meta: {
      field: "room",
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? "No room",
          color: opts.get(sample)?.color || undefined,
        }),
      },
    },
  }
}
