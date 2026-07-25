import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DeviceRole } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of device roles". Every surface that
// lists device roles — /device-roles, the monitoring configuration tab — builds
// its columns here so a role row reads identically everywhere. Page-specific
// columns (the monitoring binding control) are spliced around this factory's
// output; the shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type DeviceRoleColumnId =
  | "numid"
  | "name"
  | "description"
  | "devices"
  | "vms"
  | "updated"

const CANONICAL_ORDER: DeviceRoleColumnId[] = [
  "numid",
  "name",
  "description",
  "devices",
  "vms",
  "updated",
]

export interface DeviceRoleColumnOpts<T extends DeviceRole = DeviceRole> {
  /** Drop columns. */
  omit?: DeviceRoleColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: DeviceRoleColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Facet treatment for the Devices / VMs counts. The list page filters on
   * "in use vs unused" across both counts; the monitoring configuration tab
   * filters each count by numeric range. */
  countFacets?: "usage" | "range"
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildDeviceRoleColumns<T extends DeviceRole = DeviceRole>(
  opts: DeviceRoleColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: DeviceRoleColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))
  const ranges = opts.countFacets === "range"

  const byId: Record<DeviceRoleColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/device-roles/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    devices: () => ({
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
      meta: ranges
        ? {
            facet: {
              kind: "range",
              label: "Devices",
              get: (r: T) => r.device_count,
              min: 0,
            },
          }
        : {
            facet: {
              kind: "enum",
              label: "Usage",
              get: (r: T) => (r.device_count + r.vm_count > 0 ? "in" : "out"),
              formatValue: (v) => ({
                label: v === "in" ? "In use" : "Unused",
              }),
            },
          },
    }),
    vms: () => ({
      id: "vms",
      accessorKey: "vm_count",
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.vm_count}</span>
      ),
      ...(ranges
        ? {
            meta: {
              facet: {
                kind: "range" as const,
                label: "VMs",
                get: (r: T) => r.vm_count,
                min: 0,
              },
            },
          }
        : {}),
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
