import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { VirtualSwitch } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"

// The one source of truth for "a table of virtual switches" -
// /virtual-switches builds here. Switches come from the sync; their page edits
// the VRF and uplinks, so there is no row actions column.

export type VirtualSwitchColumnId =
  "name" | "kind" | "cluster" | "vrf" | "uplinks" | "mtu"

const CANONICAL_ORDER: VirtualSwitchColumnId[] = [
  "name",
  "kind",
  "cluster",
  "vrf",
  "uplinks",
  "mtu",
]

export interface VirtualSwitchColumnOpts {
  omit?: VirtualSwitchColumnId[]
  include?: VirtualSwitchColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
}

const none = <span className="text-muted-foreground">-</span>

export function buildVirtualSwitchColumns<
  T extends VirtualSwitch = VirtualSwitch,
>(opts: VirtualSwitchColumnOpts = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: VirtualSwitchColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<VirtualSwitchColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/virtual-switches/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    kind: () => ({
      id: "kind",
      accessorKey: "kind_display",
      header: "Kind",
      cell: ({ row }) =>
        row.original.kind_display ? (
          <Badge variant="outline" className="text-[10px]">
            {row.original.kind_display}
          </Badge>
        ) : (
          none
        ),
    }),
    cluster: () => ({
      id: "cluster",
      header: "Cluster",
      cell: ({ row }) =>
        row.original.cluster ? (
          <Link
            to="/clusters/$id"
            params={{ id: row.original.cluster.id }}
            className="link text-xs"
          >
            {row.original.cluster.name}
          </Link>
        ) : (
          none
        ),
    }),
    vrf: () => ({
      id: "vrf",
      accessorFn: (r) => r.vrf?.name ?? "",
      header: "VRF",
      cell: ({ row }) =>
        row.original.vrf ? (
          <Link
            to="/vrfs/$id"
            params={{ id: row.original.vrf.id }}
            className="link text-xs"
          >
            {row.original.vrf.name}
          </Link>
        ) : (
          none
        ),
    }),
    uplinks: () => ({
      id: "uplinks",
      accessorKey: "uplinks",
      header: "Uplinks",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.uplinks || "-"}</span>
      ),
    }),
    mtu: () => ({
      id: "mtu",
      accessorKey: "mtu",
      header: "MTU",
      cell: ({ row }) =>
        row.original.mtu != null ? (
          <span className="num text-xs">{row.original.mtu}</span>
        ) : (
          none
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  return cols
}
