import type { ColumnDef } from "@tanstack/react-table"

import type { ConsolePort } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { CableChip } from "@/components/cells/cable-chip"
import { cablePortActionsColumn } from "@/components/columns/component-port-actions"
import type { CablePortActionOpts } from "@/components/columns/component-port-actions"

/** Console ports and console server ports share one row shape - only the
 * name column's noun and the cable-termination kind differ. */
export type ConsolePortColumnId =
  | "name"
  | "type"
  | "speed"
  | "cable"
  | "description"

export const CONSOLE_PORT_COLUMNS: ConsolePortColumnId[] = [
  "name",
  "type",
  "speed",
  "cable",
  "description",
]

const dash = <span className="text-muted-foreground">-</span>

export function buildConsolePortColumns({
  header,
  kind,
  include = CONSOLE_PORT_COLUMNS,
  actions,
}: {
  /** The name column's heading: "Console port" or "Console server port". */
  header: string
  /** Cable-termination kind of the rows. */
  kind: "console_port" | "console_server_port"
  include?: ConsolePortColumnId[]
  /** Row actions; omitted, the table is read-only. */
  actions?: CablePortActionOpts<ConsolePort>
}): ColumnDef<ConsolePort>[] {
  const byId: Record<ConsolePortColumnId, () => ColumnDef<ConsolePort>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label={header} />,
      meta: { label: header },
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
    speed: () => ({
      id: "speed",
      accessorFn: (r) => r.speed ?? undefined,
      sortUndefined: "last",
      header: ({ column }) => <SortHeader column={column} label="Speed" />,
      meta: { label: "Speed" },
      cell: ({ row }) =>
        row.original.speed != null ? (
          <span className="num text-xs">{row.original.speed} baud</span>
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
    ...(actions ? [cablePortActionsColumn<ConsolePort>(kind, actions)] : []),
  ]
}
