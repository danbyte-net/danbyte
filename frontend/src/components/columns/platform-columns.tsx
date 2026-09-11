import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Platform } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { lifecycleColumn } from "@/components/cells/lifecycle-cell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of platforms" - /platforms and the
// monitoring policy tab both build here, so a platform row reads the same in
// each. Page-specific columns are spliced around the output.

export type PlatformColumnId =
  | "numid"
  | "name"
  | "manufacturer"
  | "devices"
  | "lifecycle"
  | "description"
  | "updated"

const CANONICAL_ORDER: PlatformColumnId[] = [
  "numid",
  "name",
  "manufacturer",
  "devices",
  "lifecycle",
  "description",
  "updated",
]

export interface PlatformColumnOpts<T extends Platform = Platform> {
  omit?: PlatformColumnId[]
  include?: PlatformColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Columns whose header stays plain text instead of a sortable SortHeader. */
  plainHeaders?: PlatformColumnId[]
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildPlatformColumns<T extends Platform = Platform>(
  opts: PlatformColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: PlatformColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const plain = new Set(opts.plainHeaders ?? [])
  const head = (
    id: PlatformColumnId,
    label: string
  ): ColumnDef<T, unknown>["header"] =>
    plain.has(id)
      ? label
      : ({ column }) => <SortHeader column={column} label={label} />

  const byId: Record<PlatformColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: head("name", "Name"),
      cell: ({ row }) => (
        <Link
          to="/platforms/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    manufacturer: () => ({
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: head("manufacturer", "Manufacturer"),
      cell: ({ row }) =>
        row.original.manufacturer ? (
          <Link
            to="/manufacturers/$id"
            params={{ id: row.original.manufacturer.id }}
            className="link text-xs"
          >
            {row.original.manufacturer.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Manufacturer",
          get: (r: T) => r.manufacturer?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.manufacturer?.name ?? "No manufacturer",
          }),
        },
      },
    }),
    devices: () => ({
      id: "devices",
      accessorKey: "device_count",
      header: head("devices", "Devices"),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
    }),
    lifecycle: () =>
      lifecycleColumn<T>({ get: (r) => r, header: "OS lifecycle" }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
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
