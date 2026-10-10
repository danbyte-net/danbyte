import type { ColumnDef } from "@tanstack/react-table"

import type { FrontPort } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { TagList } from "@/components/cells/tag-list"
import {
  PatchCableCell,
  patchPortActionsColumn,
} from "@/components/columns/patch-port-actions"
import type { PatchPortActionOpts } from "@/components/columns/patch-port-actions"

/** A front port: a patch panel's front jack, mapped to a rear-port strand. */
export type FrontPortColumnId =
  | "name"
  | "maps"
  | "type"
  | "cable"
  | "tags"
  | "description"

export const FRONT_PORT_COLUMNS: FrontPortColumnId[] = [
  "name",
  "maps",
  "type",
  "cable",
  "tags",
  "description",
]

const dash = <span className="text-muted-foreground">-</span>

export function buildFrontPortColumns<T extends FrontPort = FrontPort>({
  include = FRONT_PORT_COLUMNS,
  actions,
}: {
  include?: FrontPortColumnId[]
  /** Row actions; omitted, the table is read-only. */
  actions?: PatchPortActionOpts<T>
} = {}): ColumnDef<T>[] {
  const byId: Record<FrontPortColumnId, () => ColumnDef<T>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Front port" />,
      meta: { label: "Front port" },
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
    maps: () => ({
      id: "maps",
      accessorFn: (r) => `${r.rear_port.name} ${r.rear_port_position}`,
      header: ({ column }) => <SortHeader column={column} label="Maps to" />,
      meta: { label: "Maps to" },
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.rear_port.name}
          <span className="text-muted-foreground">
            {" "}
            · strand {row.original.rear_port_position}
          </span>
        </span>
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
    ...(actions ? [patchPortActionsColumn<T>("front_port", actions)] : []),
  ]
}
