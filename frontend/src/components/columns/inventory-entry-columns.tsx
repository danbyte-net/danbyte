import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { InventoryCountRow, InventoryEntryRow } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { siteColumn } from "@/components/cells/site-cell"
import { locationColumn } from "@/components/cells/location-cell"
import { manufacturerColumn } from "@/components/cells/manufacturer-cell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { KIND_LABEL } from "@/components/columns/inventory-item-columns"

/**
 * The Inventory page (docs/dcim/stock.md): every inventory item and
 * installed module with where it is - one factory for the list, and one for
 * its Counts view.
 */

export const HOME_LABEL: Record<InventoryEntryRow["home"], string> = {
  port: "In a port",
  bay: "In a bay",
  device: "On a device",
  stock: "In stock",
}

const mono = "font-mono text-xs"

function kindColumn<T extends { kind: string }>(): ColumnDef<T, unknown> {
  return {
    id: "kind",
    accessorFn: (r) => KIND_LABEL[r.kind] ?? r.kind,
    header: ({ column }) => <SortHeader column={column} label="Kind" />,
    cell: ({ getValue }) => (
      <span className="text-xs">{getValue<string>()}</span>
    ),
    meta: {
      facet: {
        kind: "enum",
        label: "Kind",
        get: (r: T) => r.kind,
        formatValue: (v: string) => ({ label: KIND_LABEL[v] ?? v }),
      },
    },
  }
}

/** Where a part is: its device and port or bay, else in stock. */
export function PlaceCell({ row }: { row: InventoryEntryRow }) {
  if (!row.device) {
    return <span className="text-muted-foreground">{HOME_LABEL.stock}</span>
  }
  return (
    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
      <Link
        to="/devices/$id"
        params={{ id: row.device.id }}
        className="link font-medium"
      >
        {row.device.name}
      </Link>
      {row.interface ? (
        <>
          <span className="text-muted-foreground">·</span>
          <Link
            to="/interfaces/$id"
            params={{ id: row.interface.id }}
            className="link font-mono text-xs"
          >
            {row.interface.name}
          </Link>
        </>
      ) : (
        row.module_bay && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-xs">{row.module_bay.name}</span>
          </>
        )
      )}
    </span>
  )
}

export function buildInventoryColumns(): ColumnDef<
  InventoryEntryRow,
  unknown
>[] {
  return [
    selectionColumn<InventoryEntryRow>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) =>
        row.original.module_type ? (
          <Link
            to="/module-types/$id"
            params={{ id: row.original.module_type.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ) : (
          <span className="font-medium">{row.original.name}</span>
        ),
    },
    {
      id: "part_id",
      accessorKey: "part_id",
      header: ({ column }) => <SortHeader column={column} label="Part ID" />,
      cell: ({ row }) => (
        <span className={mono}>{row.original.part_id || "-"}</span>
      ),
    },
    {
      id: "serial_number",
      accessorKey: "serial_number",
      header: ({ column }) => <SortHeader column={column} label="Serial" />,
      cell: ({ row }) => (
        <span className={mono}>{row.original.serial_number || "-"}</span>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: InventoryEntryRow) => r.status?.id ?? "__none__",
          formatValue: (_v: string, sample: InventoryEntryRow) => ({
            label: sample.status?.name ?? "No status",
            color: sample.status?.color,
            textColor: sample.status?.text_color,
          }),
        },
        export: { value: (r: InventoryEntryRow) => r.status?.name ?? "" },
      },
    },
    kindColumn<InventoryEntryRow>(),
    {
      id: "home",
      accessorFn: (r) => HOME_LABEL[r.home],
      header: ({ column }) => <SortHeader column={column} label="Where" />,
      cell: ({ getValue }) => (
        <span className="text-xs whitespace-nowrap">{getValue<string>()}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Where",
          get: (r: InventoryEntryRow) => r.home,
          formatValue: (v: string) => ({
            label: HOME_LABEL[v as InventoryEntryRow["home"]],
          }),
        },
      },
    },
    {
      id: "place",
      accessorFn: (r) =>
        r.device
          ? [r.device.name, (r.interface ?? r.module_bay)?.name]
              .filter(Boolean)
              .join(" · ")
          : HOME_LABEL.stock,
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => <PlaceCell row={row.original} />,
    },
    siteColumn<InventoryEntryRow>({ get: (r) => r.site }),
    locationColumn<InventoryEntryRow>({ get: (r) => r.location }),
    manufacturerColumn<InventoryEntryRow>({ get: (r) => r.manufacturer }),
    {
      id: "asset_tag",
      accessorKey: "asset_tag",
      header: ({ column }) => <SortHeader column={column} label="Asset tag" />,
      cell: ({ row }) => (
        <span className={mono}>{row.original.asset_tag || "-"}</span>
      ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: ({ column }) => (
        <SortHeader column={column} label="Description" />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    },
    timeAgoColumn<InventoryEntryRow>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
    }),
  ]
}

/** The Counts view: how many of each part are where. */
export function buildInventoryCountColumns(): ColumnDef<
  InventoryCountRow,
  unknown
>[] {
  return [
    {
      id: "part",
      accessorKey: "part",
      header: ({ column }) => <SortHeader column={column} label="Part" />,
      // Every unit of the part, wherever it is.
      cell: ({ row }) => (
        <Link
          to="/inventory"
          search={{ q: row.original.part }}
          className="link font-mono text-xs font-medium"
        >
          {row.original.part}
        </Link>
      ),
    },
    kindColumn<InventoryCountRow>(),
    manufacturerColumn<InventoryCountRow>({ get: (r) => r.manufacturer }),
    siteColumn<InventoryCountRow>({ get: (r) => r.site }),
    locationColumn<InventoryCountRow>({ get: (r) => r.location }),
    {
      id: "count",
      accessorKey: "count",
      header: ({ column }) => <SortHeader column={column} label="Count" />,
      // The units this row counts: the part at this row's place.
      cell: ({ row }) => {
        const r = row.original
        return (
          <Link
            to="/inventory"
            search={{
              q: r.part,
              kind: r.kind,
              ...(r.site ? { site: r.site.id } : {}),
              ...(r.location ? { location: r.location.id } : {}),
              ...(r.manufacturer ? { manufacturer: r.manufacturer.id } : {}),
            }}
            className="link num font-mono text-xs"
          >
            {r.count}
          </Link>
        )
      },
    },
  ]
}
