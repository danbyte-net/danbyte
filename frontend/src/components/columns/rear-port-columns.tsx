import type { ColumnDef } from "@tanstack/react-table"

import type { RearPort } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { TagList } from "@/components/cells/tag-list"
import {
  PatchCableCell,
  patchPortActionsColumn,
} from "@/components/columns/patch-port-actions"
import type { PatchPortActionOpts } from "@/components/columns/patch-port-actions"

/** A rear port: the back of a patch panel, split into strands (positions)
 * that front ports map onto. */
export type RearPortColumnId =
  | "name"
  | "positions"
  | "type"
  | "fronts"
  | "cable"
  | "tags"
  | "description"

export const REAR_PORT_COLUMNS: RearPortColumnId[] = [
  "name",
  "positions",
  "type",
  "fronts",
  "cable",
  "tags",
  "description",
]

const dash = <span className="text-muted-foreground">-</span>

export function buildRearPortColumns<T extends RearPort = RearPort>({
  include = REAR_PORT_COLUMNS,
  actions,
}: {
  include?: RearPortColumnId[]
  /** Row actions; omitted, the table is read-only. */
  actions?: PatchPortActionOpts<T>
} = {}): ColumnDef<T>[] {
  const byId: Record<RearPortColumnId, () => ColumnDef<T>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Rear port" />,
      meta: { label: "Rear port" },
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono font-medium">{row.original.name}</span>
          {row.original.label && (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {row.original.label}
            </span>
          )}
        </span>
      ),
    }),
    positions: () => ({
      id: "positions",
      accessorFn: (r) => r.positions,
      header: ({ column }) => <SortHeader column={column} label="Positions" />,
      meta: { label: "Positions" },
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.positions}</span>
      ),
    }),
    type: () => ({
      id: "type",
      accessorFn: (r) => r.type,
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      meta: { label: "Type" },
      cell: ({ row }) =>
        row.original.type ? (
          <span className="font-mono text-xs">{row.original.type}</span>
        ) : (
          dash
        ),
    }),
    fronts: () => ({
      id: "fronts",
      accessorFn: (r) => r.front_port_count,
      header: ({ column }) => (
        <SortHeader column={column} label="Front ports" />
      ),
      meta: { label: "Front ports" },
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.front_port_count}</span>
      ),
    }),
    cable: () => ({
      id: "cable",
      accessorFn: (r) => r.cable?.type ?? "",
      header: "Cable",
      cell: ({ row }) => <PatchCableCell cable={row.original.cable} />,
    }),
    tags: () => ({
      id: "tags",
      accessorFn: (r) => r.tags.map((t) => t.name).join(" "),
      header: "Tags",
      cell: ({ row }) =>
        row.original.tags.length ? <TagList tags={row.original.tags} /> : dash,
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
    ...(actions ? [patchPortActionsColumn<T>("rear_port", actions)] : []),
  ]
}
