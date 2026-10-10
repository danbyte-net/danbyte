import type { ColumnDef } from "@tanstack/react-table"

import type { PowerOutlet } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { CableChip } from "@/components/cells/cable-chip"
import { cablePortActionsColumn } from "@/components/columns/component-port-actions"
import type { CablePortActionOpts } from "@/components/columns/component-port-actions"

/** A power outlet: a socket a PDU offers, fed by one of its power ports. */
export type PowerOutletColumnId =
  | "name"
  | "type"
  | "fed_by"
  | "feed_leg"
  | "cable"
  | "description"

export const POWER_OUTLET_COLUMNS: PowerOutletColumnId[] = [
  "name",
  "type",
  "fed_by",
  "feed_leg",
  "cable",
  "description",
]

const dash = <span className="text-muted-foreground">-</span>

export function buildPowerOutletColumns({
  include = POWER_OUTLET_COLUMNS,
  actions,
}: {
  include?: PowerOutletColumnId[]
  /** Row actions; omitted, the table is read-only. */
  actions?: CablePortActionOpts<PowerOutlet>
} = {}): ColumnDef<PowerOutlet>[] {
  const byId: Record<PowerOutletColumnId, () => ColumnDef<PowerOutlet>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => (
        <SortHeader column={column} label="Power outlet" />
      ),
      meta: { label: "Power outlet" },
      cell: ({ row }) => (
        <span className="font-mono font-medium">{row.original.name}</span>
      ),
    }),
    type: () => ({
      id: "type",
      accessorFn: (r) => (r.type ? r.type_display : ""),
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      meta: { label: "Type" },
      cell: ({ row }) =>
        row.original.type ? (
          <span className="text-xs">{row.original.type_display}</span>
        ) : (
          dash
        ),
    }),
    fed_by: () => ({
      id: "fed_by",
      accessorFn: (r) => r.power_port?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Fed by" />,
      meta: { label: "Fed by" },
      cell: ({ row }) =>
        row.original.power_port ? (
          <span className="font-mono text-xs">
            {row.original.power_port.name}
          </span>
        ) : (
          dash
        ),
    }),
    feed_leg: () => ({
      id: "feed_leg",
      accessorFn: (r) => r.feed_leg,
      header: ({ column }) => <SortHeader column={column} label="Feed leg" />,
      meta: { label: "Feed leg" },
      cell: ({ row }) =>
        row.original.feed_leg ? (
          <span className="text-xs">{row.original.feed_leg}</span>
        ) : (
          dash
        ),
    }),
    cable: () => ({
      id: "cable",
      accessorFn: (r) => r.cable?.type ?? "",
      header: "Cable",
      cell: ({ row }) => <CableChip cable={row.original.cable} />,
    }),
    description: () => ({
      id: "description",
      accessorFn: (r) => r.description,
      header: "Description",
      cell: ({ row }) =>
        row.original.description ? (
          <span className="text-xs">{row.original.description}</span>
        ) : (
          dash
        ),
    }),
  }
  return [
    ...include.map((id) => byId[id]()),
    ...(actions
      ? [cablePortActionsColumn<PowerOutlet>("power_outlet", actions)]
      : []),
  ]
}
