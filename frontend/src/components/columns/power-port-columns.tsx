import type { ColumnDef } from "@tanstack/react-table"

import type { PowerPort } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { CableChip } from "@/components/cells/cable-chip"
import { cablePortActionsColumn } from "@/components/columns/component-port-actions"
import type { CablePortActionOpts } from "@/components/columns/component-port-actions"

/** A power port: the device's inlet (PSU). */
export type PowerPortColumnId =
  | "name"
  | "type"
  | "max_draw"
  | "allocated_draw"
  | "cable"
  | "description"

export const POWER_PORT_COLUMNS: PowerPortColumnId[] = [
  "name",
  "type",
  "max_draw",
  "allocated_draw",
  "cable",
  "description",
]

const dash = <span className="text-muted-foreground">-</span>

export function buildPowerPortColumns({
  include = POWER_PORT_COLUMNS,
  actions,
}: {
  include?: PowerPortColumnId[]
  /** Row actions; omitted, the table is read-only. */
  actions?: CablePortActionOpts<PowerPort>
} = {}): ColumnDef<PowerPort>[] {
  const watts = (id: "max_draw" | "allocated_draw", label: string) =>
    ({
      id,
      accessorFn: (r) =>
        (id === "max_draw" ? r.maximum_draw : r.allocated_draw) ?? undefined,
      sortUndefined: "last",
      header: ({ column }) => <SortHeader column={column} label={label} />,
      meta: { label },
      cell: ({ getValue }) => {
        const w = getValue<number | undefined>()
        return w != null ? <span className="num text-xs">{w} W</span> : dash
      },
    }) satisfies ColumnDef<PowerPort>
  const byId: Record<PowerPortColumnId, () => ColumnDef<PowerPort>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Power port" />,
      meta: { label: "Power port" },
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
    max_draw: () => watts("max_draw", "Max draw"),
    allocated_draw: () => watts("allocated_draw", "Allocated"),
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
      ? [cablePortActionsColumn<PowerPort>("power_port", actions)]
      : []),
  ]
}
