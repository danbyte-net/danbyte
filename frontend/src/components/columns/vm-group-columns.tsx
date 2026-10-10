import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { VirtualMachineGroup } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { siteColumn } from "@/components/cells/site-cell"
import { countCell } from "@/components/cells/count-cell"
import type { ZeroCounts } from "@/components/cells/count-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of VM groups". /vm-groups and the
// cluster page's Groups tab both build their columns here so a group row
// reads identically everywhere.

export type VmGroupColumnId =
  | "numid"
  | "name"
  | "kind"
  | "cluster"
  | "site"
  | "vms"
  | "tags"
  | "description"
  | "updated"

const CANONICAL_ORDER: VmGroupColumnId[] = [
  "numid",
  "name",
  "kind",
  "cluster",
  "site",
  "vms",
  "tags",
  "description",
  "updated",
]

export interface VmGroupColumnOpts<
  T extends VirtualMachineGroup = VirtualMachineGroup,
> {
  omit?: VmGroupColumnId[]
  include?: VmGroupColumnId[]
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  zeroCounts?: ZeroCounts
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

export function buildVmGroupColumns<
  T extends VirtualMachineGroup = VirtualMachineGroup,
>(opts: VmGroupColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: VmGroupColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<VmGroupColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/vm-groups/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    kind: () => ({
      id: "kind",
      accessorFn: (r) => r.kind_display,
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      cell: ({ row }) => (
        <span className="text-xs">{row.original.kind_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: T) => r.kind_display,
        },
      },
    }),
    cluster: () => ({
      id: "cluster",
      accessorFn: (r) => r.cluster.name,
      header: ({ column }) => <SortHeader column={column} label="Cluster" />,
      cell: ({ row }) => (
        <Link
          to="/clusters/$id"
          params={{ id: row.original.cluster.id }}
          className="link text-xs"
        >
          {row.original.cluster.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Cluster",
          get: (r: T) => r.cluster.name,
        },
      },
    }),
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    vms: () => ({
      id: "vms",
      accessorKey: "vm_count",
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) => countCell(row.original.vm_count, opts.zeroCounts),
    }),
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
